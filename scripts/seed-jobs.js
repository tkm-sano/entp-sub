#!/usr/bin/env node

const { readFileSync } = require("node:fs");
const path = require("node:path");
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

initializeApp({
  credential: applicationDefault()
});

const db = getFirestore();
const file = path.resolve(__dirname, "../data/sample-jobs.json");
const jobs = JSON.parse(readFileSync(file, "utf8"));

async function run() {
  for (const job of jobs) {
    const ref = db.collection("jobs").doc(job.id);
    const deadline = new Date(job.deadline);
    await ref.set({
      ...job,
      deadline: Timestamp.fromDate(deadline),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now()
    });
    console.log(`seeded: ${job.id}`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
