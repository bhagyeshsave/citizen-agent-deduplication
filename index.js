// index.js for Agent 3: De-duplication
const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const { VertexAI } = require('@google-cloud/vertexai');
const firestore = new Firestore();

const app = express();
app.use(express.json());

// Initialize Vertex AI for text embeddings
const vertexAI = new VertexAI({ project: process.env.GCP_PROJECT_ID, location: 'us-central1' });
const textEmbeddingModel = vertexAI.getGenerativeModel({ model: 'textembedding-gecko@001' });

// Function to calculate cosine similarity between two vectors
function cosineSimilarity(vecA, vecB) {
  const dotProduct = vecA.reduce((acc, val, i) => acc + val * vecB[i], 0);
  const magA = Math.sqrt(vecA.reduce((acc, val) => acc + val * val, 0));
  const magB = Math.sqrt(vecB.reduce((acc, val) => acc + val * val, 0));
  return dotProduct / (magA * magB);
}

app.post('/deduplicate', async (req, res) => {
  const newReport = req.body; // Expects validated data from Agent 1

  // 1. Generate an embedding for the new report's summary
  const [embeddingResponse] = await textEmbeddingModel.embedContents([{ content: newReport.summary }]);
  const newReportVector = embeddingResponse.embeddings[0].values;

  // 2. Query for potentially similar open issues (same category)
  const querySnapshot = await firestore.collection('issues')
    .where('status', '==', 'Open')
    .where('category', '==', newReport.category)
    .get();

  let bestMatch = { issueId: null, score: 0.0 };
  
  // 3. Compare the new report to existing ones
  querySnapshot.forEach(doc => {
    const existingIssue = doc.data();
    if (existingIssue.summary_embedding) {
      const similarity = cosineSimilarity(newReportVector, existingIssue.summary_embedding);
      if (similarity > bestMatch.score) {
        bestMatch = { issueId: doc.id, score: similarity };
      }
    }
  });

  // 4. Decide whether to chain or create
  const DUPLICATION_THRESHOLD = 0.85; // This is a tunable parameter

  if (bestMatch.score > DUPLICATION_THRESHOLD) {
    // It's a duplicate. Chain it to the existing issue.
    const issueRef = firestore.collection('issues').doc(bestMatch.issueId);
    await issueRef.update({
      duplicate_count: Firestore.FieldValue.increment(1),
      last_updated: new Date(),
      // Optionally add the new report's text as a "comment"
    });
    console.log(`Chained to existing issue ${bestMatch.issueId}`);
    res.status(200).json({ status: "DUPLICATE", chained_to_issue_id: bestMatch.issueId });
  } else {
    // It's a new issue. Create it.
    const newIssue = {
      ...newReport,
      status: 'Open',
      created_at: new Date(),
      last_updated: new Date(),
      duplicate_count: 1,
      upvotes: 0,
      importance_score: 0, // Agent 4 will calculate this
      summary_embedding: newReportVector, // Store the vector for future comparisons
    };
    const docRef = await firestore.collection('issues').add(newIssue);
    console.log(`Created new issue ${docRef.id}`);
    res.status(201).json({ status: "CREATED", issue_id: docRef.id });
  }
});