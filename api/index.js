'use strict';

// Vercel serverless funkcia – celé API (a osobné odkazy /me/…) obsluhuje Express aplikácia.
module.exports = require('../src/app').app;
