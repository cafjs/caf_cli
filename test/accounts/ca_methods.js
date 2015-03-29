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
//var caf = require('caf_core');

var accUtils = require('./ca_methods_utils');

exports.methods = {
    '__ca_init__' : function(cb) {
        this.state.accounts = {};
        accUtils.initSessions(this);
        accUtils.defaultAccounts(this);
        accUtils.loadKeys(this, cb);
    },
    '__ca_resume__' : function(cp, cb) {
        accUtils.initSessions(this);
        accUtils.loadKeys(this, cb);
    },
    'hello' : function(user, cb) {
        try {
            var server = accUtils.sessionInstance(this, user.username);
            cb(null, server.hello(user));
        } catch(err) {
            if (user && (typeof user.username === 'string')) {
                accUtils.deleteSession(this, user.username);
            }
            cb(err);
        }
    },
    'newToken' : function(challenge, tokenConstr, cb) {
        try {
            var server = accUtils.lookupSession(this, tokenConstr.caOwner);
            cb(null, server.newToken(challenge, tokenConstr));
        } catch(err) {
            if (tokenConstr && (typeof tokenConstr.caOwner === 'string')) {
                accUtils.deleteSession(this, tokenConstr.caOwner);
            }
            cb(err);
        }
    },
    'newAccount' : function(account, cb) {
        try {
            accUtils.addAccount(this, account);
            cb(null);
        } catch(err) {
            cb(err);
        }
    }
};

//caf.init(module);

