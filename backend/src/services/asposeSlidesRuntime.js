require("dotenv").config();

const fs = require("fs");

let aspose = null;
let java = null;
let licenseApplied = false;

function loadAspose() {
  if (aspose) return aspose;
  aspose = { slides: require("aspose.slides.via.java") };
  java = require("java");
  return aspose;
}

function loadJava() {
  loadAspose();
  return java;
}

// Applies the Aspose.Slides license once per process, before the first
// Presentation is created. Runs fine without a license file too -- Aspose
// falls back to evaluation mode (adds a watermark, otherwise fully functional).
function ensureLicense() {
  if (licenseApplied) return;
  loadAspose();
  const licensePath = process.env.ASPOSE_SLIDES_LICENSE_PATH;
  if (licensePath && fs.existsSync(licensePath)) {
    const license = new aspose.slides.License();
    license.setLicense(licensePath);
  }
  licenseApplied = true;
}

module.exports = { loadAspose, loadJava, ensureLicense };
