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
 * Registers a new user using a node.js client.
 *
 * Registration is implicit when using the launcher app, and explicit
 * registration is only needed in special cases, e.g., only headless
 * operation.
 *
 * @module caf_cli/CreateUser
 */

const json_rpc = require('caf_transport').json_rpc;
const session = require('./Session');
const urlParser = require('url');
const PEOPLE_APP = 'root-people';
const PEOPLE_CA = 'me';

/**
 * Explicit registration of a new user.
 *
 * This is only needed for testing or headless operation.
 *
 * @param {string} url The target url provided to the original session call.
 * @param {sessionOptionsType} options The properties of the original session.
 * @param {cbType} cb A standard callback to notify correct user registration or
 *  an error.
 *
 * @memberof! module:caf_cli/CreateUser
 * @alias newUser
 */
exports.newUser = function(url, options, cb) {
    let alreadyCalled = false;

    const cbOnce = function(err, data) {
        if (alreadyCalled) {
            options.log && options.log('Warning: Calling newUser cb twice');
        } else {
            alreadyCalled = true;
            cb(err, data);
        }
    };

    try {
        const parsedURL = urlParser.parse(url);
        const h = parsedURL.host.split('.');
        h.shift();
        h.unshift(PEOPLE_APP);
        parsedURL.host = h.join('.');
        parsedURL.search = null; //remove query
        parsedURL.hash = null; // remove fragment
        const peopleURL = urlParser.format(parsedURL);

        const username = json_rpc.splitName(options.from)[0];
        const from = json_rpc.joinName(username, PEOPLE_CA);

        const spec = {
            log: options.log,
            securityClient: options.securityClient,
            password: options.password,
            unrestrictedToken: false,
            disableBackchannel: true,
            from: from,
            ca: from
        };

        const s = session.Session(peopleURL, null, spec);

        s.onopen = function() {
            // Success, opening a session without errors creates the CA
            s.close();
        };

        s.onclose = function(err) {
            if (err) {
                cbOnce(err);
            } else {
                const msg = 'Success registering user ' + username;
                //options.log && options.log(msg);
                cbOnce(null, msg);
            }
        };

    } catch (err) {
        cbOnce(err);
    }
};
