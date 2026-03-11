import { Buffer } from 'buffer';

if (typeof window !== 'undefined') {
    window.global = window.global || window;
    window.Buffer = window.Buffer || Buffer;
    window.process = window.process || { env: {}, nextTick: function(fn) { setTimeout(fn, 0); } };
    window.process.env = window.process.env || {};
    console.log('Polyfills: Buffer and Process initialized');
}
