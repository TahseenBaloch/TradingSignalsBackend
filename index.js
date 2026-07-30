const express = require('express');

const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.json({ message: 'Backend server is running' });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
