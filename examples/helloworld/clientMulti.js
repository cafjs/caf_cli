'use strict';
/* eslint-disable  no-console */

const caf_core = require('caf_core');
const caf_comp = caf_core.caf_components;
const myUtils = caf_comp.myUtils;
const caf_cli = caf_core.caf_cli;

/* `from` CA needs to be the same as target `ca` to enable creation, i.e.,
 *  only owners can create CAs.
 *
 *  With security on, we would need a token to authenticate `from`.
 */
const URL = 'http://root-hello.localtest.me:3000/#from=foo-ca1&ca=foo-ca1';

const s = new caf_cli.Session(URL);

s.onopen = async () => {
    try {
        const counter = await s.increment().decrement().getPromise();
        console.log('Final count:' + counter);
        s.close();
    } catch (err) {
        s.close(err);
    }
};

s.onclose = (err) => {
    if (err) {
        console.log(myUtils.errToPrettyStr(err));
        process.exit(1);
    }
    console.log('Done OK');
};
