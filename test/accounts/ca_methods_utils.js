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
var caf = require('caf_core');
var async = caf.async;
var caf_security = require('caf_security');
var secUtils = caf_security.utils;
var caf_srp = require('caf_srp');
var srpClient = caf_srp.client;
var srpServer = caf_srp.server;

var loadKeys = exports.loadKeys = function(self, cb) {
    var pubFile = self.$.props.pubFile || 'rsa_pub.pem';
    var privFile = self.$.props.privFile || 'rsa_priv.pem';
    var keysDir = self.$.props.keysDir || __dirname;
    async.parallel({
                       pubKey: function(cb0) {
                           secUtils.loadKey(keysDir, pubFile, cb0);
                       },
                       privKey: function(cb0) {
                           secUtils.loadKey(keysDir, privFile, cb0);
                     }
                   },
                   function(err, results) {
                       if (err) {
                           cb(err);
                       } else {
                           self.scratch.keys = results;
                           cb(null);
                       }
                   });
};

exports.lookupSession = function(self, user) {
    return  self.scratch.srpSessions[user];
};

exports.deleteSession = function(self, user) {
    delete self.scratch.srpSessions[user];
};

exports.initSessions = function(self) {
    self.scratch.srpSessions = {};
};

var sessionInstance = exports.sessionInstance = function(self, user) {
    var server = self.scratch.srpSessions[user];
    if (!server) {
        server = srpServer.serverInstance(self.state.accounts,
                                          self.scratch.keys.privKey,
                                          self.scratch.keys.pubKey);
        self.scratch.srpSessions[user] = server;
    }
    return server;
};

var addAccount = exports.addAccount = function(self, account) {
    var server = srpServer.serverInstance(self.state.accounts);
    server.newAccount(account);
};

exports.defaultAccounts = function(self) {
    if (Array.isArray(self.$.props.testAccounts)) {
        self.$.props.testAccounts
            .forEach(function(acc) {
                         var cl = srpClient.clientInstance(acc.username,
                                                           acc.password);
                         addAccount(self, cl.newAccount());
                     });
    }
};
