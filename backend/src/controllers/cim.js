const cimService = require("../services/cimService");
const cimGeneratorService = require("../services/cimGeneratorService");
const companyService = require("../services/companyService");

// ---------------------------------------------------------------------------
// CIM
// ---------------------------------------------------------------------------

async function getOrCreateCim(req, res) {
  try {
    const { companyId } = req.params;
    const cim = await cimService.getCimByCompanyId(companyId, req.user?.id);
    res.json(cim);
  } catch (err) {
    console.error("[getOrCreateCim]", err.message);
    res.status(500).json({ error: err.message });
  }
}

async function updateCim(req, res) {
  try {
    const { id } = req.params;
    const { section_data, section_key } = req.body;

    if (!section_data || typeof section_data !== "object") {
      return res.status(400).json({ error: "section_data object required" });
    }

    const updated = await cimService.updateCimSections(id, section_data, req.user?.id, section_key);
    res.json(updated);
  } catch (err) {
    console.error("[updateCim]", err.message);
    res.status(500).json({ error: err.message });
  }
}

async function updateCimStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = [
      "draft", "questionnaire_pending", "questionnaire_answered",
      "broker_editing", "client_review", "revision_requested",
      "approved", "generated",
    ];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const updated = await cimService.updateCimStatus(id, status);
    res.json(updated);
  } catch (err) {
    console.error("[updateCimStatus]", err.message);
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Questionnaires
// ---------------------------------------------------------------------------

async function listQuestionnaires(req, res) {
  try {
    const { cimId } = req.params;
    const data = await cimService.listQuestionnaires(cimId);
    res.json(data);
  } catch (err) {
    console.error("[listQuestionnaires]", err.message);
    res.status(500).json({ error: err.message });
  }
}

async function createQuestionnaire(req, res) {
  try {
    const { cimId } = req.params;
    const { title, category } = req.body;
    if (!title) return res.status(400).json({ error: "title required" });
    const data = await cimService.createQuestionnaire(cimId, { title, category, createdBy: req.user?.id });
    res.status(201).json(data);
  } catch (err) {
    console.error("[createQuestionnaire]", err.message);
    res.status(500).json({ error: err.message });
  }
}

async function updateQuestionnaire(req, res) {
  try {
    const { questionnaireId } = req.params;
    const data = await cimService.updateQuestionnaire(questionnaireId, req.body);
    res.json(data);
  } catch (err) {
    console.error("[updateQuestionnaire]", err.message);
    res.status(500).json({ error: err.message });
  }
}

async function sendQuestionnaire(req, res) {
  try {
    const { questionnaireId } = req.params;
    const data = await cimService.sendQuestionnaire(questionnaireId);
    res.json(data);
  } catch (err) {
    console.error("[sendQuestionnaire]", err.message);
    res.status(500).json({ error: err.message });
  }
}

async function deleteQuestionnaire(req, res) {
  try {
    const { questionnaireId } = req.params;
    await cimService.deleteQuestionnaire(questionnaireId);
    res.json({ ok: true });
  } catch (err) {
    console.error("[deleteQuestionnaire]", err.message);
    res.status(500).json({ error: err.message });
  }
}

async function getQuestionnaire(req, res) {
  try {
    const { questionnaireId } = req.params;
    const data = await cimService.getQuestionnaireWithDetails(questionnaireId);
    if (!data) return res.status(404).json({ error: "Questionnaire not found" });
    res.json(data);
  } catch (err) {
    console.error("[getQuestionnaire]", err.message);
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

async function addQuestions(req, res) {
  try {
    const { questionnaireId } = req.params;
    const { questions } = req.body;
    if (!Array.isArray(questions) || !questions.length) {
      return res.status(400).json({ error: "questions array required" });
    }
    const data = await cimService.addQuestions(questionnaireId, questions);
    res.status(201).json(data);
  } catch (err) {
    console.error("[addQuestions]", err.message);
    res.status(500).json({ error: err.message });
  }
}

async function deleteQuestion(req, res) {
  try {
    const { questionId } = req.params;
    await cimService.deleteQuestion(questionId);
    res.json({ ok: true });
  } catch (err) {
    console.error("[deleteQuestion]", err.message);
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Responses (client-facing)
// ---------------------------------------------------------------------------

async function saveResponse(req, res) {
  try {
    const { questionId } = req.params;
    const { response_text, is_draft } = req.body;
    const data = await cimService.saveResponse(questionId, {
      responseText: response_text,
      isDraft: is_draft !== false,
      answeredBy: req.user?.id,
    });
    res.json(data);
  } catch (err) {
    console.error("[saveResponse]", err.message);
    res.status(500).json({ error: err.message });
  }
}

async function submitQuestionnaire(req, res) {
  try {
    const { questionnaireId } = req.params;
    const data = await cimService.submitQuestionnaire(questionnaireId, req.user?.id);
    res.json(data);
  } catch (err) {
    console.error("[submitQuestionnaire]", err.message);
    res.status(500).json({ error: err.message });
  }
}

async function getClientQuestionnaires(req, res) {
  try {
    const { companyId } = req.params;
    const data = await cimService.getQuestionnairesForCompany(companyId);
    res.json(data);
  } catch (err) {
    console.error("[getClientQuestionnaires]", err.message);
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Review comments
// ---------------------------------------------------------------------------

async function getComments(req, res) {
  try {
    const { id } = req.params;
    const data = await cimService.getComments(id);
    res.json(data);
  } catch (err) {
    console.error("[getComments]", err.message);
    res.status(500).json({ error: err.message });
  }
}

async function addComment(req, res) {
  try {
    const { id } = req.params;
    const { section_key, field_key, comment_text } = req.body;
    if (!comment_text) return res.status(400).json({ error: "comment_text required" });
    const reviewerName = req.user?.name || req.user?.firstName || req.user?.email || null;
    const data = await cimService.addComment(id, {
      sectionKey: section_key,
      fieldKey: field_key || null,
      commentText: comment_text,
      reviewerId: req.user?.id,
      reviewerName,
    });
    res.status(201).json(data);
  } catch (err) {
    console.error("[addComment]", err.message);
    res.status(500).json({ error: err.message });
  }
}

async function updateComment(req, res) {
  try {
    const { commentId } = req.params;
    const { status } = req.body;
    const data = await cimService.updateComment(commentId, { status, resolvedBy: req.user?.id });
    res.json(data);
  } catch (err) {
    console.error("[updateComment]", err.message);
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

async function generateCim(req, res) {
  try {
    const { id } = req.params;
    const cim = await cimService.getCimById(id);
    if (!cim) return res.status(404).json({ error: "CIM not found" });

    let companyName = "";
    try {
      const company = await companyService.getCompanyById(cim.company_id);
      companyName = company?.name || "";
    } catch { /* non-fatal */ }

    const generation = await cimService.createGeneration(id, req.user?.id);

    let buffer;
    try {
      buffer = await cimGeneratorService.generateCim(cim, companyName);
    } catch (genErr) {
      await cimService.updateGenerationStatus(generation.id, "failed", genErr.message);
      return res.status(500).json({ error: "PPTX generation failed: " + genErr.message });
    }

    const fileName = `CIM_${(companyName || "company").replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}.pptx`;
    await cimService.updateGenerationStatus(generation.id, "completed");
    await cimService.updateCimStatus(id, "generated");

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(buffer);
  } catch (err) {
    console.error("[generateCim]", err.message);
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Revision history
// ---------------------------------------------------------------------------

async function getRevisionHistory(req, res) {
  try {
    const { id } = req.params;
    const data = await cimService.getRevisionHistory(id);
    res.json(data);
  } catch (err) {
    console.error("[getRevisionHistory]", err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getOrCreateCim, updateCim, updateCimStatus,
  listQuestionnaires, createQuestionnaire, updateQuestionnaire,
  sendQuestionnaire, deleteQuestionnaire, getQuestionnaire,
  addQuestions, deleteQuestion,
  saveResponse, submitQuestionnaire, getClientQuestionnaires,
  getComments, addComment, updateComment,
  generateCim, getRevisionHistory,
};
