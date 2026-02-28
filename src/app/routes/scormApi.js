const express = require('express');
const router = express.Router();
const bodyParser = require('body-parser');
const cassandra = require('cassandra-driver');
const proxy = require('express-http-proxy');
const { logger } = require('@project-sunbird/logger');

// Cassandra client
const client = new cassandra.Client({
  contactPoints: ['localhost:9042'],
  localDataCenter: 'datacenter1',
  keyspace: 'sunbird_courses'
});

// Initialize SCORM session
router.post('/api/scorm/v1/initialize', bodyParser.json(), async (req, res) => {
  try {
    const { contentId, userId = 'guest', courseId, batchId } = req.body;
    logger.info('SCORM Initialize:', { contentId, userId, courseId, batchId });

    res.json({
      success: true,
      sessionId: `${userId}_${contentId}_${Date.now()}`
    });
  } catch (error) {
    logger.error('SCORM Initialize Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Commit SCORM data
router.post('/api/scorm/v1/commit', bodyParser.json(), async (req, res) => {
  try {
    const {
      contentId,
      userId = 'guest',
      courseId = contentId,
      batchId = 'default',
      cmiData
    } = req.body;

    logger.info('SCORM Commit:', { contentId, userId, dataSize: JSON.stringify(cmiData).length });

    // Store in Cassandra
    const query = `
      INSERT INTO user_content_consumption 
      (userid, courseid, batchid, contentid, scorm_suspend_data, last_updated_time, status)
      VALUES (?, ?, ?, ?, ?, toTimestamp(now()), 1)
    `;

    await client.execute(query, [
      userId,
      courseId,
      batchId,
      contentId,
      JSON.stringify(cmiData)
    ], { prepare: true });

    res.json({ success: true });
  } catch (error) {
    logger.error('SCORM Commit Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get SCORM data
router.get('/api/scorm/v1/data/:contentId', async (req, res) => {
  try {
    const { contentId } = req.params;
    const userId = req.query.userId || 'guest';
    const courseId = req.query.courseId || contentId;
    const batchId = req.query.batchId || 'default';

    logger.info('SCORM Get Data:', { contentId, userId, courseId, batchId });

    const query = `
      SELECT scorm_suspend_data FROM user_content_consumption
      WHERE userid = ? AND courseid = ? AND batchid = ? AND contentid = ?
    `;

    const result = await client.execute(query, [userId, courseId, batchId, contentId], { prepare: true });

    if (result.rows.length > 0 && result.rows[0].scorm_suspend_data) {
      const data = JSON.parse(result.rows[0].scorm_suspend_data);
      res.json({ success: true, data });
    } else {
      res.json({ success: true, data: {} });
    }
  } catch (error) {
    logger.error('SCORM Get Data Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Terminate SCORM session
router.post('/api/scorm/v1/terminate', bodyParser.json(), async (req, res) => {
  try {
    const { contentId, userId = 'guest' } = req.body;
    logger.info('SCORM Terminate:', { contentId, userId });

    res.json({ success: true });
  } catch (error) {
    logger.error('SCORM Terminate Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Proxy for SCORM content to avoid cross-origin iframe restrictions
router.use('/content-storage', proxy('http://localhost:9001', {
  proxyReqPathResolver: function (req) {
    return require('url').parse(req.originalUrl.replace('/content-storage', '')).path;
  }
}));

module.exports = router;
