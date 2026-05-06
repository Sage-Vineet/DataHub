const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../../../.env") });

async function list() {
  const apiKey = process.env.GEMINI_API_KEY;
  const genAI = new GoogleGenerativeAI(apiKey);
  
  try {
    // There is no direct listModels on genAI, but we can try to fetch it via the client
    // Actually, the easiest way is to use the REST API via axios
    const axios = require("axios");
    const resp = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    console.log("AVAILABLE MODELS:", resp.data.models.map(m => m.name));
  } catch (err) {
    console.error("Error listing models:", err.message);
  }
}

list();
