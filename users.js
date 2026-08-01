const bcrypt = require('bcryptjs');

// Hardcoded accounts for personal use — no database.
// Change the password here and restart the server to update it.
const users = [
  {
    id: 1,
    email: 'tahsindev2026@gmail.com',
    passwordHash: bcrypt.hashSync('tahsindev2026', 10),
  },
];

function findUserByEmail(email) {
  return users.find((user) => user.email === email);
}

module.exports = { users, findUserByEmail };
