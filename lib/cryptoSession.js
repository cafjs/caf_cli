// Modifications copyright 2020 Caf.js Labs and contributors
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

'use strict';

/**
 * End-to-end message encryption/authentication using ephemeral Diffie-Hellman
 * keys.
 *
 * The assumption is that DH public keys are exchanged using a trusted path,
 * e.g., the trusted bus between CAs in the Cloud, and then the derived shared
 * secret, not known by the CAs, can be used to establish a direct, secure
 * channel to send messages.
 *
 * CAs are very efficient at distributing public keys (using `SharedMaps`, see
 * {@link external:caf_sharing}) and
 * this allow us to treat DH keys as ephemeral, i.e., each `Session` has fresh
 * keys. This avoids the difficulty of protecting in the browser long-term
 * secrets that are javascript-accessible.
 *
 * @module caf_cli/cryptoSession
 */
const crypto = require('crypto');
const assert = require('assert');

// 2048 bits
// eslint-disable-next-line
const DH_PRIME= 'faeb653502021d204f43f924f756a8c96ac23a9b68a78c86d0c7c0ada0e9d042b467f3e6733f7c3a0a43f18f850d5b9b75f2483aded9e1f21a1a1eeaccb1ff25256281e69ef6c01b0d4837679f1f3022b1adb74a8b6413b2d069d6ed322476f542f3b8dcc09465346865fbeafe6ba7d1fe18fbce0c213278f2f56fe5ae32efbfa250716f884a07bbd5a05cc29ed4737f3feff30a59913ad287c0f4ef8861ff74d1de061482a16b69643c9b1b4e65c68d588c015df722849e157fb2de8df84ddac21f2f14369e5b2c3fa3c152bba83d71ca2a139f51161f328e22505a4f7201c8c475ac4fe32b2aa72cf7d678dc22c3e376727a0177fefc63b3961fe3533f2aa3';

const DH_GENERATOR = '02';

const CIPHER_ALGO = 'aes-256-cbc';
const HMAC_ALGO = 'sha256';
const IV_LENGTH = 16;

/**
 * Constructor.
 *
 * @memberof! module:caf_cli/cryptoSession
 * @alias create
 */
exports.create = function() {

    var authKey = null;
    var encKey = null;
    // @ts-ignore: bug in type declaration, no need of `string`
    const dh = crypto.createDiffieHellman(Buffer.from(DH_PRIME, 'hex'),
                                          Buffer.from(DH_GENERATOR, 'hex'));
    const dhPubKey = dh.generateKeys().toString('hex');
    const that = {};

    const setMasterKey = function(masterKey) {
        const hash = crypto.createHash('sha512');
        const tempKey = hash.update(masterKey).digest();
        authKey = tempKey.slice(0, 32);
        encKey = tempKey.slice(32);
    };

    const checkInitialized = function() {
        if ((authKey === null) || (encKey === null)) {
            const err = new Error('Not initialized');
            throw err;
        }
    };

    /**
     * Encrypts a message and generates an authentication code for it.
     *
     * The DH public key of the other party  needs to be set first.
     *
     * @param {string} msg A message to encrypt
     *
     * @return {string} An encrypted and authenticated message.
     *
     * @memberof! module:caf_cli/cryptoSession#
     * @alias encryptAndMAC
     */
    that.encryptAndMAC = function(msg) {
        checkInitialized();
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(CIPHER_ALGO, encKey, iv);
        let enc = cipher.update(msg, 'utf8', 'hex');
        enc += cipher.final('hex');
        const hmac = crypto.createHmac(HMAC_ALGO, authKey);
        const ivStr = iv.toString('hex');
        hmac.update(ivStr + '$' + enc, 'utf8');
        return ivStr + '$' + enc + '$' + hmac.digest('hex');
    };

    /**
     * Decrypts a message and validates its authentication code.
     *
     * The DH public key of the other party  needs to be set first.
     *
     * @param {string} msg A message to decrypt
     *
     * @return {string} A decrypted and validated message.
     *
     * @memberof! module:caf_cli/cryptoSession#
     * @alias authAndDecrypt
     */
    that.authAndDecrypt = function(msg) {
        checkInitialized();
        const all = msg.trim().split('$');
        assert(all.length === 3, 'Invalid encrypted message');
        const hmac = crypto.createHmac(HMAC_ALGO, authKey);
        hmac.update(all[0] + '$' + all[1], 'utf8');
        assert(all[2] === hmac.digest('hex'), 'Cannot authenticate msg');
        const iv = Buffer.from(all[0], 'hex');
        const decipher = crypto.createDecipheriv(CIPHER_ALGO, encKey, iv);
        let decrypted = decipher.update(all[1], 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    };

    /**
     * Returns a DH public key associated with this session.
     *
     * @return {string} A DH public key associated with this session.
     *
     * @memberof! module:caf_cli/cryptoSession#
     * @alias getPublicKey
     */
    that.getPublicKey = function() {
        return dhPubKey;
    };

    /**
     * Sets the DH public key of the other party, enabling the other
     * crypto operations (encrypt/decrypt/mac).
     *
     * @param{string} otherPubKey A serialized DH public key.
     *
     * @memberof! module:caf_cli/cryptoSession#
     * @alias setOtherPublicKey
     *
     */
    that.setOtherPublicKey = function(otherPubKey) {
        const other = Buffer.from(otherPubKey, 'hex');
        setMasterKey(dh.computeSecret(other));
    };

    Object.freeze(that);

    return that;
};
