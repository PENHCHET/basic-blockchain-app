/**
 * Copyright 2016 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an 'AS IS' BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

var path = require('path');
var fs = require('fs-extra');
var os = require('os');

var jsrsa = require('jsrsasign');
var KEYUTIL = jsrsa.KEYUTIL;

var hfc = require('fabric-client');
var copService = require('fabric-ca-client/lib/FabricCAClientImpl.js');
var User = require('fabric-client/lib/User.js');
var CryptoSuite = require('fabric-client/lib/impl/CryptoSuite_ECDSA_AES.js');
var KeyStore = require('fabric-client/lib/impl/CryptoKeyStore.js');
var ecdsaKey = require('fabric-client/lib/impl/ecdsa/key.js');
var LocalMSP = require('fabric-client/lib/msp/msp.js');
var idModule = require('fabric-client/lib/msp/identity.js');
var SigningIdentity = idModule.SigningIdentity;
var Signer = idModule.Signer;

var parameters = require('./parameters.json');

module.exports.CHAINCODE_PATH = parameters.properties.chaincodePath;
module.exports.END2END = {
	channel: parameters.properties.channelName,
	chaincodeId: parameters.properties.chaincodeId,
	chaincodeVersion: parameters.properties.chaincodeVersion
};

// directory for file based KeyValueStore
module.exports.KVS = '/tmp/hfc-test-kvs';
module.exports.storePathForOrg = function(org) {
	return module.exports.KVS + '_' + org;
};

// temporarily set $GOPATH to the test fixture folder
module.exports.setupChaincodeDeploy = function() {
	process.env.GOPATH = path.join(__dirname, '../fixtures');
};

// specifically set the values to defaults because they may have been overridden when
// running in the overall test bucket ('gulp test')
module.exports.resetDefaults = function() {
	global.hfc.config = undefined;
	require('nconf').reset();
};

module.exports.cleanupDir = function(keyValStorePath) {
	var absPath = path.join(process.cwd(), keyValStorePath);
	var exists = module.exports.existsSync(absPath);
	if (exists) {
		fs.removeSync(absPath);
	}
};

module.exports.getUniqueVersion = function(prefix) {
	if (!prefix) prefix = 'v';
	return prefix + Date.now();
};

// utility function to check if directory or file exists
// uses entire / absolute path from root
module.exports.existsSync = function(absolutePath /*string*/) {
	try  {
		var stat = fs.statSync(absolutePath);
		if (stat.isDirectory() || stat.isFile()) {
			return true;
		} else
			return false;
	}
	catch (e) {
		return false;
	}
};

module.exports.readFile = readFile;

hfc.addConfigFile(path.join(__dirname, 'config.json'));
var ORGS = hfc.getConfigSetting('test-network');

var	tlsOptions = {
	trustedRoots: [],
	verify: false
};

function getRegistrar(username, client, t, loadFromConfig, userOrg) {
	var caUrl = ORGS[userOrg].ca;
	var cop = new copService(caUrl, tlsOptions);
	var req = {
		enrollmentID: 'admin',
		enrollmentSecret: 'adminpw'
	};
	var eResult, client, member, webAdmin;
	return cop.enroll(req)
	.then((enrollment) => {
	t.pass('Successfully enrolled \'' + req.enrollmentID + '\'.');
	eResult = enrollment;

	//check that we got back the expected certificate
	//var cert = new X509();
	//cert.readCertPEM(enrollment.certificate);
	//t.comment(cert.getSubjectString());
	return cop.cryptoPrimitives.importKey(enrollment.certificate);
},(err) => {
	t.fail('Failed to enroll the admin. Can not progress any further. Exiting. ' + err.stack ? err.stack : err);

	t.end();
}).then((pubKey) => {
	t.pass('Successfully imported public key from the resulting enrollment certificate');
	var msp = new LocalMSP({
		id: ORGS[userOrg].mspid,
		cryptoSuite: cop.cryptoPrimitives
	});

	var signingIdentity = new SigningIdentity('testSigningIdentity', eResult.certificate, pubKey, msp, new Signer(msp.cryptoSuite, eResult.key));
	t.comment('Registering '+username);
	return cop._fabricCAClient.register(username, 'client', userOrg, 1, [], signingIdentity);
},(err) => {
	t.fail('Failed to import the public key from the enrollment certificate. ' + err.stack ? err.stack : err);
	t.end();
}).then((secret) => {
	console.log('secret: ' + JSON.stringify(secret));
	t.comment(secret);
	newsecret = secret; // to be used in the next test case

	t.pass('testUser \'' + username + '\'');
	}).then(() => {

		return cop.enroll({
			enrollmentID: username,
			//enrollmentSecret: password
			enrollmentSecret: newsecret
		}).then((enrollment) => {
			t.pass('Successfully enrolled user \'' + username + '\'');

			member = new User(username);
			return member.setEnrollment(enrollment.key, enrollment.certificate, ORGS[userOrg].mspid);
		}).then(() => {
			return client.setUserContext(member);
		}).then(() => {
			return Promise.resolve(member);
		}).catch((err) => {
			t.fail('Failed to enroll and persist user. Error: ' + err.stack ? err.stack : err);
			t.end();
		});
	}).catch((err) => {
		t.fail('Failed to register user. Error: ' + err.stack ? err.stack : err);
		t.end();
	});

}

module.exports.getRegistrar = getRegistrar;


function getSubmitter(username, password, client, t, loadFromConfig, userOrg) {
	var caUrl = ORGS[userOrg].ca;

	return client.getUserContext(username, true)
	.then((user) => {
		return new Promise((resolve, reject) => {
			if (user && user.isEnrolled()) {
				t.pass('Successfully loaded member from persistence');
				return resolve(user);
			}

			if (!loadFromConfig) {
				// need to enroll it with CA server
				var cop = new copService(caUrl, tlsOptions);

				var member;
				return cop.enroll({
					enrollmentID: username,
					enrollmentSecret: password
				}).then((enrollment) => {
					t.pass('Successfully enrolled user (util.js) \'' + username + '\'');

					member = new User(username);
					return member.setEnrollment(enrollment.key, enrollment.certificate, ORGS[userOrg].mspid);
				}).then(() => {
					return client.setUserContext(member);
				}).then(() => {
					return resolve(member);
				}).catch((err) => {
					t.fail('Failed to enroll and persist user. Error: ' + err.stack ? err.stack : err);
					t.end();
				});
			} else {
				// need to load private key and pre-enrolled certificate from files based on the MSP
				// config directory structure:
				// <config>
				//    \_ keystore
				//       \_ admin.pem  <<== this is the private key saved in PEM file
				//    \_ signcerts
				//       \_ admin.pem  <<== this is the signed certificate saved in PEM file

				// first load the private key and save in the BCCSP's key store
				var privKeyPEM = path.join(__dirname, '/msp/local/keystore/admin.pem');
				var pemData, member;
				return readFile(privKeyPEM)
				.then((data) => {
					pemData = data;
					// default crypto suite uses $HOME/.hfc-key-store as key store
					var kspath = CryptoSuite.getDefaultKeyStorePath();
					var testKey;
					return new KeyStore({
						path: kspath
					});
				}).then((store) => {
					var rawKey = KEYUTIL.getKey(pemData.toString());
					testKey = new ecdsaKey(rawKey);
					return store.putKey(testKey);
				}).then((value) => {
					// next save the certificate in a serialized user enrollment in the state store
					var certPEM = path.join(__dirname, '/msp/local/signcerts/admin.pem');
					return readFile(certPEM);
				}).then((data) => {
					member = new User(username);
					return member.setEnrollment(testKey, data.toString(), ORGS[userOrg].mspid);
				}).then(() => {
					return client.setUserContext(member);
				}).then((user) => {
					return resolve(user);
				}).catch((err) => {
					reject(new Error('Failed to load key or certificate and save to local stores. ' + err));
					t.end();
				});
			}
		});
	});
}

function readFile(path) {
	return new Promise((resolve, reject) => {
		fs.readFile(path, (err, data) => {
			if (!!err)
				reject(new Error('Failed to read file ' + path + ' due to error: ' + err));
			else
				resolve(data);
		});
	});
}

module.exports.getSubmitter = function(client, test, loadFromConfig, org) {
	if (arguments.length < 2) throw new Error('"client" and "test" are both required parameters');

	var fromConfig, userOrg;
	if (typeof loadFromConfig === 'boolean') {
		fromConfig = loadFromConfig;
	} else {
		fromConfig = false;
	}

	if (typeof loadFromConfig === 'string') {
		userOrg = loadFromConfig;
	} else {
		if (typeof org === 'string') {
			userOrg = org;
		} else {
			userOrg = 'org1';
		}
	}

	return getSubmitter('admin', 'adminpw', client, test, fromConfig, userOrg);
};

module.exports.getArgs = function(chaincodeArgs) {
	var args = [];
	for (var i = 0; i < chaincodeArgs.length; i++) {
		args.push(chaincodeArgs[i]);
	}
	return args;
};
