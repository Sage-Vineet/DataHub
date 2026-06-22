const { supabase } = require("../db");
const { Pool } = require("pg");

// ---------------------------------------------------------------------------
// Raw pg pool — used for DDL (CREATE TABLE) and as a fallback for queries
// when Supabase's PostgREST schema cache hasn't picked up newly-created tables.
// Same pattern as companyService.js and other services in this codebase.
// ---------------------------------------------------------------------------
let _pool = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 3000,
    });
  }
  return _pool;
}

async function pgQuery(text, params = []) {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL not configured");
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Table auto-create (pg DDL — bypasses PostgREST schema cache entirely)
// ---------------------------------------------------------------------------
let _tablesEnsured = false;

async function ensureCimTables() {
  if (_tablesEnsured) return;
  const pool = getPool();
  if (!pool) {
    console.warn("[CIM] DATABASE_URL not set — cannot auto-create CIM tables. Run cim_schema.sql manually in Supabase.");
    return;
  }
  const ddl = `
    CREATE TABLE IF NOT EXISTS cims (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'draft',
      section_data JSONB NOT NULL DEFAULT '{}',
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(company_id)
    );
    CREATE TABLE IF NOT EXISTS cim_questionnaires (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cim_id UUID NOT NULL,
      title TEXT NOT NULL,
      category TEXT,
      status VARCHAR(50) NOT NULL DEFAULT 'draft',
      sent_at TIMESTAMPTZ,
      answered_at TIMESTAMPTZ,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cim_questions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      questionnaire_id UUID NOT NULL,
      question_text TEXT NOT NULL,
      question_type VARCHAR(50) NOT NULL DEFAULT 'text',
      is_required BOOLEAN NOT NULL DEFAULT false,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cim_question_responses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      question_id UUID NOT NULL,
      answered_by UUID,
      response_text TEXT,
      is_draft BOOLEAN NOT NULL DEFAULT true,
      submitted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(question_id)
    );
    CREATE TABLE IF NOT EXISTS cim_review_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cim_id UUID NOT NULL,
      reviewer_id UUID,
      reviewer_name TEXT,
      section_key TEXT NOT NULL DEFAULT '__global__',
      field_key TEXT,
      comment_text TEXT NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'open',
      resolved_by UUID,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE cim_review_comments ADD COLUMN IF NOT EXISTS field_key TEXT;
    ALTER TABLE cim_review_comments ADD COLUMN IF NOT EXISTS reviewer_name TEXT;
    CREATE TABLE IF NOT EXISTS cim_revision_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cim_id UUID NOT NULL,
      changed_by UUID,
      section_key TEXT,
      old_value JSONB,
      new_value JSONB,
      action VARCHAR(50),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cim_generations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cim_id UUID NOT NULL,
      generated_by UUID,
      file_name TEXT,
      generation_status VARCHAR(50) NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  try {
    await pgQuery(ddl);
    _tablesEnsured = true;
    console.log("[CIM] Tables ready.");
  } catch (err) {
    console.error("[CIM] Table creation failed:", err.message);
    // Don't mark as ensured — retry on next call.
  }
}

// Run on module load so tables exist before the first request hits.
ensureCimTables().catch(() => {});

// ---------------------------------------------------------------------------
// CIM CRUD — primary: pg; falls back gracefully on missing DATABASE_URL
// ---------------------------------------------------------------------------

async function getCimByCompanyId(companyId, createdBy) {
  await ensureCimTables();

  // Try pg first (guaranteed to see newly-created tables)
  try {
    const { rows } = await pgQuery(
      "SELECT * FROM cims WHERE company_id = $1 LIMIT 1",
      [companyId]
    );
    if (rows[0]) return rows[0];

    // Create new CIM
    const ins = await pgQuery(
      `INSERT INTO cims (company_id, created_by)
       VALUES ($1, $2)
       ON CONFLICT (company_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [companyId, createdBy || null]
    );
    return ins.rows[0];
  } catch (pgErr) {
    console.error("[getCimByCompanyId] pg error, falling back to supabase:", pgErr.message);
  }

  // Supabase fallback
  const { data: existing, error: fetchErr } = await supabase
    .from("cims")
    .select("*")
    .eq("company_id", companyId)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (existing) return existing;

  const { data, error } = await supabase
    .from("cims")
    .insert({ company_id: companyId, created_by: createdBy || null })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function getCimById(cimId) {
  await ensureCimTables();
  try {
    const { rows } = await pgQuery("SELECT * FROM cims WHERE id = $1 LIMIT 1", [cimId]);
    return rows[0] || null;
  } catch {
    const { data, error } = await supabase.from("cims").select("*").eq("id", cimId).maybeSingle();
    if (error) throw error;
    return data;
  }
}

async function updateCimSections(cimId, sectionData, changedBy, sectionKey) {
  await ensureCimTables();
  try {
    // Read current, merge, write back
    const { rows: cur } = await pgQuery("SELECT section_data FROM cims WHERE id = $1", [cimId]);
    const current = cur[0]?.section_data || {};
    const merged = { ...current, ...sectionData };

    const { rows } = await pgQuery(
      "UPDATE cims SET section_data = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
      [JSON.stringify(merged), cimId]
    );

    if (sectionKey && changedBy) {
      pgQuery(
        `INSERT INTO cim_revision_history (cim_id, changed_by, section_key, old_value, new_value, action)
         VALUES ($1, $2, $3, $4, $5, 'update')`,
        [cimId, changedBy, sectionKey, JSON.stringify(current[sectionKey] || null), JSON.stringify(sectionData[sectionKey] || null)]
      ).catch(() => {});
    }
    return rows[0];
  } catch {
    const { data: current } = await supabase.from("cims").select("section_data").eq("id", cimId).single();
    const merged = { ...(current?.section_data || {}), ...sectionData };
    const { data, error } = await supabase.from("cims").update({ section_data: merged, updated_at: new Date().toISOString() }).eq("id", cimId).select("*").single();
    if (error) throw error;
    return data;
  }
}

async function updateCimStatus(cimId, status) {
  await ensureCimTables();
  try {
    const { rows } = await pgQuery("UPDATE cims SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *", [status, cimId]);
    return rows[0];
  } catch {
    const { data, error } = await supabase.from("cims").update({ status, updated_at: new Date().toISOString() }).eq("id", cimId).select("*").single();
    if (error) throw error;
    return data;
  }
}

// ---------------------------------------------------------------------------
// Questionnaires
// ---------------------------------------------------------------------------

async function listQuestionnaires(cimId) {
  await ensureCimTables();
  try {
    const { rows: questionnaires } = await pgQuery(
      "SELECT * FROM cim_questionnaires WHERE cim_id = $1 ORDER BY created_at DESC",
      [cimId]
    );
    if (!questionnaires.length) return [];

    const ids = questionnaires.map((q) => q.id);
    const { rows: questions } = await pgQuery(
      `SELECT id, questionnaire_id FROM cim_questions WHERE questionnaire_id = ANY($1::uuid[])`,
      [ids]
    );
    const countMap = {};
    for (const q of questions) countMap[q.questionnaire_id] = (countMap[q.questionnaire_id] || 0) + 1;
    return questionnaires.map((q) => ({ ...q, question_count: countMap[q.id] || 0 }));
  } catch {
    const { data: questionnaires, error } = await supabase.from("cim_questionnaires").select("*").eq("cim_id", cimId).order("created_at", { ascending: false });
    if (error) throw error;
    return (questionnaires || []).map((q) => ({ ...q, question_count: 0 }));
  }
}

async function createQuestionnaire(cimId, { title, category, createdBy }) {
  await ensureCimTables();
  try {
    const { rows } = await pgQuery(
      "INSERT INTO cim_questionnaires (cim_id, title, category, created_by) VALUES ($1, $2, $3, $4) RETURNING *",
      [cimId, title, category || null, createdBy || null]
    );
    return rows[0];
  } catch {
    const { data, error } = await supabase.from("cim_questionnaires").insert({ cim_id: cimId, title, category: category || null, created_by: createdBy || null }).select("*").single();
    if (error) throw error;
    return data;
  }
}

async function updateQuestionnaire(questionnaireId, fields) {
  await ensureCimTables();
  const allowed = ["title", "category", "status", "sent_at", "answered_at"];
  const sets = ["updated_at = NOW()"];
  const vals = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) { vals.push(fields[key]); sets.push(`${key} = $${vals.length}`); }
  }
  vals.push(questionnaireId);
  try {
    const { rows } = await pgQuery(`UPDATE cim_questionnaires SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals);
    return rows[0];
  } catch {
    const patch = { updated_at: new Date().toISOString() };
    for (const k of allowed) { if (fields[k] !== undefined) patch[k] = fields[k]; }
    const { data, error } = await supabase.from("cim_questionnaires").update(patch).eq("id", questionnaireId).select("*").single();
    if (error) throw error;
    return data;
  }
}

async function sendQuestionnaire(questionnaireId) {
  return updateQuestionnaire(questionnaireId, { status: "sent", sent_at: new Date().toISOString() });
}

async function deleteQuestionnaire(questionnaireId) {
  await ensureCimTables();
  try {
    await pgQuery("DELETE FROM cim_questions WHERE questionnaire_id = $1", [questionnaireId]);
    await pgQuery("DELETE FROM cim_questionnaires WHERE id = $1", [questionnaireId]);
  } catch {
    await supabase.from("cim_questionnaires").delete().eq("id", questionnaireId);
  }
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

async function addQuestions(questionnaireId, questions) {
  await ensureCimTables();
  try {
    const { rows: existing } = await pgQuery(
      "SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM cim_questions WHERE questionnaire_id = $1",
      [questionnaireId]
    );
    let nextOrder = (existing[0]?.max_order ?? -1) + 1;

    const inserted = [];
    for (const q of questions) {
      const { rows } = await pgQuery(
        "INSERT INTO cim_questions (questionnaire_id, question_text, question_type, is_required, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [questionnaireId, q.question_text, q.question_type || "text", q.is_required || false, nextOrder++]
      );
      inserted.push(rows[0]);
    }
    return inserted;
  } catch {
    const rows = questions.map((q, i) => ({ questionnaire_id: questionnaireId, question_text: q.question_text, question_type: q.question_type || "text", is_required: q.is_required || false, sort_order: i }));
    const { data, error } = await supabase.from("cim_questions").insert(rows).select("*");
    if (error) throw error;
    return data;
  }
}

async function deleteQuestion(questionId) {
  await ensureCimTables();
  try {
    await pgQuery("DELETE FROM cim_question_responses WHERE question_id = $1", [questionId]);
    await pgQuery("DELETE FROM cim_questions WHERE id = $1", [questionId]);
  } catch {
    await supabase.from("cim_questions").delete().eq("id", questionId);
  }
}

async function getQuestionnaireWithDetails(questionnaireId) {
  await ensureCimTables();
  try {
    const { rows: [questionnaire] } = await pgQuery("SELECT * FROM cim_questionnaires WHERE id = $1", [questionnaireId]);
    if (!questionnaire) return null;

    const { rows: questions } = await pgQuery(
      "SELECT * FROM cim_questions WHERE questionnaire_id = $1 ORDER BY sort_order ASC",
      [questionnaireId]
    );

    const qIds = questions.map((q) => q.id);
    let responses = [];
    if (qIds.length) {
      const { rows } = await pgQuery(
        "SELECT * FROM cim_question_responses WHERE question_id = ANY($1::uuid[])",
        [qIds]
      );
      responses = rows;
    }
    const responseMap = Object.fromEntries(responses.map((r) => [r.question_id, r]));
    return { ...questionnaire, questions: questions.map((q) => ({ ...q, response: responseMap[q.id] || null })) };
  } catch {
    const { data: questionnaire, error: qErr } = await supabase.from("cim_questionnaires").select("*").eq("id", questionnaireId).maybeSingle();
    if (qErr) throw qErr;
    if (!questionnaire) return null;
    const { data: questions } = await supabase.from("cim_questions").select("*").eq("questionnaire_id", questionnaireId).order("sort_order");
    const qIds = (questions || []).map((q) => q.id);
    const { data: responses } = qIds.length ? await supabase.from("cim_question_responses").select("*").in("question_id", qIds) : { data: [] };
    const responseMap = Object.fromEntries((responses || []).map((r) => [r.question_id, r]));
    return { ...questionnaire, questions: (questions || []).map((q) => ({ ...q, response: responseMap[q.id] || null })) };
  }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

async function saveResponse(questionId, { responseText, isDraft, answeredBy }) {
  await ensureCimTables();
  try {
    const { rows } = await pgQuery(
      `INSERT INTO cim_question_responses (question_id, answered_by, response_text, is_draft)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (question_id) DO UPDATE
         SET response_text = EXCLUDED.response_text,
             answered_by   = EXCLUDED.answered_by,
             is_draft      = EXCLUDED.is_draft,
             updated_at    = NOW()
       RETURNING *`,
      [questionId, answeredBy || null, responseText || "", isDraft !== false]
    );
    return rows[0];
  } catch {
    const payload = { question_id: questionId, answered_by: answeredBy || null, response_text: responseText || "", is_draft: isDraft !== false, updated_at: new Date().toISOString() };
    const { data: existing } = await supabase.from("cim_question_responses").select("id").eq("question_id", questionId).maybeSingle();
    if (existing) {
      const { data, error } = await supabase.from("cim_question_responses").update(payload).eq("question_id", questionId).select("*").single();
      if (error) throw error;
      return data;
    }
    const { data, error } = await supabase.from("cim_question_responses").insert(payload).select("*").single();
    if (error) throw error;
    return data;
  }
}

async function submitQuestionnaire(questionnaireId, answeredBy) {
  await ensureCimTables();
  try {
    const { rows: questions } = await pgQuery("SELECT id FROM cim_questions WHERE questionnaire_id = $1", [questionnaireId]);
    const qIds = questions.map((q) => q.id);
    if (qIds.length) {
      await pgQuery(
        "UPDATE cim_question_responses SET is_draft = false, submitted_at = NOW() WHERE question_id = ANY($1::uuid[])",
        [qIds]
      );
    }
  } catch { /* non-fatal */ }
  return updateQuestionnaire(questionnaireId, { status: "answered", answered_at: new Date().toISOString() });
}

async function getQuestionnairesForCompany(companyId) {
  await ensureCimTables();
  try {
    const { rows: [cim] } = await pgQuery("SELECT id FROM cims WHERE company_id = $1 LIMIT 1", [companyId]);
    if (!cim) return [];
    const { rows } = await pgQuery(
      "SELECT * FROM cim_questionnaires WHERE cim_id = $1 AND status IN ('sent','answered') ORDER BY created_at DESC",
      [cim.id]
    );
    return rows;
  } catch {
    const { data: cim } = await supabase.from("cims").select("id").eq("company_id", companyId).maybeSingle();
    if (!cim) return [];
    const { data, error } = await supabase.from("cim_questionnaires").select("*").eq("cim_id", cim.id).in("status", ["sent", "answered"]).order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }
}

// ---------------------------------------------------------------------------
// Review comments
// ---------------------------------------------------------------------------

async function getComments(cimId) {
  await ensureCimTables();
  try {
    const { rows } = await pgQuery("SELECT * FROM cim_review_comments WHERE cim_id = $1 ORDER BY created_at ASC", [cimId]);
    return rows;
  } catch {
    const { data, error } = await supabase.from("cim_review_comments").select("*").eq("cim_id", cimId).order("created_at", { ascending: true });
    if (error) throw error;
    return data || [];
  }
}

async function addComment(cimId, { sectionKey, fieldKey, commentText, reviewerId, reviewerName }) {
  await ensureCimTables();
  try {
    const { rows } = await pgQuery(
      "INSERT INTO cim_review_comments (cim_id, reviewer_id, reviewer_name, section_key, field_key, comment_text) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [cimId, reviewerId || null, reviewerName || null, sectionKey || "__global__", fieldKey || null, commentText]
    );
    return rows[0];
  } catch {
    const { data, error } = await supabase.from("cim_review_comments").insert({
      cim_id: cimId,
      reviewer_id: reviewerId || null,
      reviewer_name: reviewerName || null,
      section_key: sectionKey || "__global__",
      field_key: fieldKey || null,
      comment_text: commentText,
    }).select("*").single();
    if (error) throw error;
    return data;
  }
}

async function updateComment(commentId, { status, resolvedBy }) {
  await ensureCimTables();
  try {
    const sets = ["updated_at = NOW()"];
    const vals = [];
    if (status) { vals.push(status); sets.push(`status = $${vals.length}`); }
    if (resolvedBy) { vals.push(resolvedBy); sets.push(`resolved_by = $${vals.length}`); vals.push(new Date().toISOString()); sets.push(`resolved_at = $${vals.length}`); }
    vals.push(commentId);
    const { rows } = await pgQuery(`UPDATE cim_review_comments SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals);
    return rows[0];
  } catch {
    const patch = { updated_at: new Date().toISOString() };
    if (status) patch.status = status;
    if (resolvedBy) { patch.resolved_by = resolvedBy; patch.resolved_at = new Date().toISOString(); }
    const { data, error } = await supabase.from("cim_review_comments").update(patch).eq("id", commentId).select("*").single();
    if (error) throw error;
    return data;
  }
}

// ---------------------------------------------------------------------------
// Generation tracking
// ---------------------------------------------------------------------------

async function createGeneration(cimId, generatedBy) {
  await ensureCimTables();
  try {
    const { rows } = await pgQuery(
      "INSERT INTO cim_generations (cim_id, generated_by) VALUES ($1,$2) RETURNING *",
      [cimId, generatedBy || null]
    );
    return rows[0];
  } catch {
    const { data, error } = await supabase.from("cim_generations").insert({ cim_id: cimId, generated_by: generatedBy || null }).select("*").single();
    if (error) throw error;
    return data;
  }
}

async function updateGenerationStatus(generationId, status, errorMessage) {
  await ensureCimTables();
  try {
    const { rows } = await pgQuery(
      "UPDATE cim_generations SET generation_status = $1, error_message = $2 WHERE id = $3 RETURNING *",
      [status, errorMessage || null, generationId]
    );
    return rows[0];
  } catch {
    const { data, error } = await supabase.from("cim_generations").update({ generation_status: status, error_message: errorMessage || null }).eq("id", generationId).select("*").single();
    if (error) throw error;
    return data;
  }
}

// ---------------------------------------------------------------------------
// Revision history
// ---------------------------------------------------------------------------

async function getRevisionHistory(cimId) {
  await ensureCimTables();
  try {
    const { rows } = await pgQuery(
      "SELECT * FROM cim_revision_history WHERE cim_id = $1 ORDER BY created_at DESC LIMIT 100",
      [cimId]
    );
    return rows;
  } catch {
    const { data, error } = await supabase.from("cim_revision_history").select("*").eq("cim_id", cimId).order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    return data || [];
  }
}

module.exports = {
  ensureCimTables,
  getCimByCompanyId,
  getCimById,
  updateCimSections,
  updateCimStatus,
  listQuestionnaires,
  createQuestionnaire,
  updateQuestionnaire,
  sendQuestionnaire,
  deleteQuestionnaire,
  addQuestions,
  deleteQuestion,
  getQuestionnaireWithDetails,
  saveResponse,
  submitQuestionnaire,
  getQuestionnairesForCompany,
  getComments,
  addComment,
  updateComment,
  createGeneration,
  updateGenerationStatus,
  getRevisionHistory,
};
