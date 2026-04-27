
const axios = require('axios');

async function testLogin() {
  try {
    console.log("Testing login with broker@leo.com / broker123");
    const res1 = await axios.post('http://localhost:4000/auth/login', {
      email: 'broker@leo.com',
      password: 'broker123'
    });
    console.log("Success:", res1.status, res1.data);
  } catch (err) {
    console.error("Failed:", err.response?.status, err.response?.data);
  }

  try {
    console.log("\nTesting login with client@infosys.com / 123456");
    const res2 = await axios.post('http://localhost:4000/auth/login', {
      email: 'client@infosys.com',
      password: '123456'
    });
    console.log("Success:", res2.status, res2.data);
  } catch (err) {
    console.error("Failed:", err.response?.status, err.response?.data);
  }
}

testLogin();
