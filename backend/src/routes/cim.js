const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/cim");

const router = express.Router();
router.use(requireAuth);

// CIM record
router.get("/cim/company/:companyId",             ctrl.getOrCreateCim);
router.patch("/cim/:id",                          ctrl.updateCim);
router.patch("/cim/:id/status",                   ctrl.updateCimStatus);
router.post("/cim/:id/generate",                  ctrl.generateCim);
router.get("/cim/:id/history",                    ctrl.getRevisionHistory);

// Questionnaires (broker)
router.get("/cim/:cimId/questionnaires",          ctrl.listQuestionnaires);
router.post("/cim/:cimId/questionnaires",         ctrl.createQuestionnaire);
router.patch("/cim/questionnaires/:questionnaireId",          ctrl.updateQuestionnaire);
router.post("/cim/questionnaires/:questionnaireId/send",      ctrl.sendQuestionnaire);
router.delete("/cim/questionnaires/:questionnaireId",         ctrl.deleteQuestionnaire);
router.get("/cim/questionnaires/:questionnaireId",            ctrl.getQuestionnaire);

// Questions
router.post("/cim/questionnaires/:questionnaireId/questions", ctrl.addQuestions);
router.delete("/cim/questions/:questionId",                   ctrl.deleteQuestion);

// Responses (client)
router.post("/cim/questions/:questionId/responses",                   ctrl.saveResponse);
router.post("/cim/questionnaires/:questionnaireId/submit",            ctrl.submitQuestionnaire);
router.get("/cim/company/:companyId/client-questionnaires",           ctrl.getClientQuestionnaires);

// Review comments
router.get("/cim/:id/comments",                   ctrl.getComments);
router.post("/cim/:id/comments",                  ctrl.addComment);
router.patch("/cim/comments/:commentId",          ctrl.updateComment);

module.exports = router;
