const QUESTION_MARK = "?";

function replaceQuestionMarksWithPgParams(sql) {
  let index = 0;
  let output = "";
  let inSingleQuote = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const prev = sql[i - 1];

    if (char === "'" && prev !== "\\") {
      inSingleQuote = !inSingleQuote;
      output += char;
      continue;
    }

    if (!inSingleQuote && char === QUESTION_MARK) {
      index += 1;
      output += `$${index}`;
      continue;
    }

    output += char;
  }

  return output;
}

function replacePgParamsWithQuestionMarks(sql) {
  return sql.replace(/\$\d+/g, QUESTION_MARK);
}

function normalizeCommonSql(sql, target) {
  if (!sql || typeof sql !== "string") return sql;

  let normalized = sql;

  if (target === "postgres") {
    normalized = replaceQuestionMarksWithPgParams(normalized);
    normalized = normalized.replace(/datetime\('now'\)/gi, "CURRENT_TIMESTAMP");
    return normalized;
  }

  normalized = replacePgParamsWithQuestionMarks(normalized);
  return normalized;
}

module.exports = {
  normalizeCommonSql,
};
