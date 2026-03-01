// contentOriginProxy.js
// Purpose: Proxy for cross-origin content files.
//
// When extracted content packages (SCORM, H5P, etc.) live on a different
// origin than the portal (e.g., MinIO on :9001 while portal is on :3000),
// the browser blocks the iframe as cross-origin. This proxy serves those
// files through the portal's own origin, making the iframe same-origin.
//
// In production behind a CDN/reverse proxy where everything is already
// same-origin, this route is never hit — the Angular component only
// rewrites URLs that are actually cross-origin.

const express = require('express');
const router = express.Router();
const proxy = require('express-http-proxy');
const envHelper = require('../helpers/environmentVariablesHelper');

// Proxy content files, stripping the /content-storage prefix
router.use('/content-storage', proxy(envHelper.SCORM_CONTENT_ORIGIN, {
  proxyReqPathResolver: function (req) {
    return require('url').parse(req.originalUrl.replace('/content-storage', '')).path;
  }
}));

module.exports = router;
