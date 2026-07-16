'use strict';

const { S3_STATE_BUCKET, S3_STATE_KEY, S3_STATE_REGION } = require('../config.cjs');

let s3Client = null;
let s3Sdk = null;

function isEnabled() {
  return Boolean(S3_STATE_BUCKET);
}

function getSdk() {
  if (!s3Sdk) s3Sdk = require('@aws-sdk/client-s3');
  return s3Sdk;
}

function getClient() {
  if (!s3Client) {
    const { S3Client } = getSdk();
    s3Client = new S3Client({ region: S3_STATE_REGION });
  }
  return s3Client;
}

async function loadFromS3() {
  if (!isEnabled()) return null;
  try {
    const { GetObjectCommand } = getSdk();
    const resp = await getClient().send(new GetObjectCommand({
      Bucket: S3_STATE_BUCKET,
      Key: S3_STATE_KEY,
    }));
    const body = await resp.Body.transformToString('utf-8');
    return JSON.parse(body);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey') {
      return null;
    }
    console.log(`  ⚠ S3 state load failed: ${err.message}`);
    return null;
  }
}

async function saveToS3(snapshot) {
  if (!isEnabled()) return;
  try {
    const { PutObjectCommand } = getSdk();
    await getClient().send(new PutObjectCommand({
      Bucket: S3_STATE_BUCKET,
      Key: S3_STATE_KEY,
      Body: JSON.stringify(snapshot, null, 2),
      ContentType: 'application/json',
    }));
    const wsCount = Object.keys(snapshot.workspaces || {}).length;
    const svcCount = Object.keys(snapshot.serviceRegistry || {}).length;
    console.log(`  [S3] State saved (${wsCount} workspaces, ${svcCount} services) → s3://${S3_STATE_BUCKET}/${S3_STATE_KEY}`);
  } catch (err) {
    console.log(`  ⚠ S3 state save failed: ${err.message}`);
  }
}

module.exports = {
  isEnabled,
  loadFromS3,
  saveToS3,
};