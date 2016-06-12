/*!
Copyright 2013 Hewlett-Packard Development Company, L.P.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
 */

"use strict";

var crypto = require('crypto');
var assert = require('assert');

// 2048 bits
var DH_PRIME= 'faeb653502021d204f43f924f756a8c96ac23a9b68a78c86d0c7c0ada0e9d042b467f3e6733f7c3a0a43f18f850d5b9b75f2483aded9e1f21a1a1eeaccb1ff25256281e69ef6c01b0d4837679f1f3022b1adb74a8b6413b2d069d6ed322476f542f3b8dcc09465346865fbeafe6ba7d1fe18fbce0c213278f2f56fe5ae32efbfa250716f884a07bbd5a05cc29ed4737f3feff30a59913ad287c0f4ef8861ff74d1de061482a16b69643c9b1b4e65c68d588c015df722849e157fb2de8df84ddac21f2f14369e5b2c3fa3c152bba83d71ca2a139f51161f328e22505a4f7201c8c475ac4fe32b2aa72cf7d678dc22c3e376727a0177fefc63b3961fe3533f2aa3';

var DH_GENERATOR = '02';

var CIPHER_ALGO = 'aes-256-ctr';
var HMAC_ALGO = 'sha256';

/**
 * End-to-end message encryption/authentication using Diffie-Hellman keys.
 *
 * The assumption is that DH public keys are exchanged using a trusted path,
 * e.g., the trusted bus between CAs in the Cloud, and then the derived shared
 * secret, not known by the CAs, can be used to establish a direct, secure
 * channel to send messages.
 *
 * CAs are very efficient at distributing public keys (using SharedMaps) and
 * this allow us to treat DH keys as ephemeral, i.e., each `Session` has fresh
 * keys. This avoids the difficulty of protecting long-term,
 * javascript-accessible, secrets in the browser.
 *
 * @module caf_cli/newInstance
 */
exports.newInstance = function() {

    var authKey = null;
    var encKey = null;
    var dh = crypto.createDiffieHellman(new Buffer(DH_PRIME, 'hex'),
                                        new Buffer(DH_GENERATOR, 'hex'));
    var dhPubKey = dh.generateKeys().toString('hex');
    var that =  {};

    var setMasterKey = function(masterKey) {
        var hash = crypto.createHash('sha512');
        var tempKey = hash.update(masterKey).digest('binary');
        authKey = tempKey.slice(0,32);
        encKey = tempKey.slice(32);
    };

    var checkInitialized = function() {
        if ((authKey === null) || (encKey === null)) {
            var err = new Error('Not initialized');
            throw err;
        }
    };

    /**
     * Encrypts a message and generates an authentication code for it.
     *
     * The DH public key of the other party  needs to be set first.
     *
     * @param {string} msg A message to encrypt
     */
    that.encryptAndMAC = function(msg) {
        checkInitialized();
        var cipher = crypto.createCipher(CIPHER_ALGO, encKey);
        var enc = cipher.update(msg, 'utf8', 'hex');
        enc += cipher.final('hex');
        var hmac = crypto.createHmac(HMAC_ALGO, authKey);
        hmac.update(enc, 'hex');
        return enc + '$' + hmac.digest('hex');
    };

    /**
     * Decrypts a message and validates its authentication code.
     *
     * The DH public key of the other party  needs to be set first.
     *
     * @param {string} msg A message to decrypt
     */
     that.authAndDecrypt = function(msg) {
        checkInitialized();
        var all = msg.trim().split('$');
        assert(all.length === 2, 'Invalid encrypted message');
        var hmac = crypto.createHmac(HMAC_ALGO, authKey);
        hmac.update(all[0], 'hex');
        assert(all[1] === hmac.digest('hex'), 'Cannot authenticate msg');
        var decipher = crypto.createDecipher(CIPHER_ALGO, encKey);
        var decrypted = decipher.update(all[0], 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    };

    /**
     * Returns a DH public key associated with this session.
     *
     * @return {string} A  DH public key associated with this session.
     */
    that.getPublicKey = function() {
        return dhPubKey;
    };

    /**
     * Sets the DH public key of the other party, enabling the other
     * crypto operations (encrypt/decrypt/mac).
     */
    that.setOtherPublicKey = function(otherPubKey) {
        var other = new Buffer(otherPubKey, 'hex');
        setMasterKey(dh.computeSecret(other));
    };

    Object.freeze(that);

    return that;
};
