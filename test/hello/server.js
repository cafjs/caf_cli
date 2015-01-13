var hello = require('./main.js');
var top;
hello.load(null, {name: 'top'}, 'framework.json', null,
           function(err, $) {
               if (err) {
                   console.log('setUP Error' + err);
                   console.log('setUP Error $' + $);
                   // ignore errors here, check in method
               } else {
                   top = $;
                   console.log('Running...');
               }
           });
