/**
 * LearnBuddy SQLite Data Store & Permission Isolation Layer
 * 
 * Provides:
 * 1. CRUD operations for users, courses, enrollments, materials, assignments, submissions
 * 2. Strict teacher/student permission filtering:
 *    - getMaterials(userId, courseId): Students only see public materials + their own private materials
 *    - getSubmissions(userId, assignmentId): Teachers can view all class submissions;
 *      students can only view their own; if submission status is not 'published',
 *      the student's suggested grades and summary are strictly blanked out.
 */

import { DatabaseSync } from "node:sqlite";
import { initSchema, seedDatabase } from "./schema.js";
import { hashPassword, issueToken, sessionExpiry } from "../services/auth.js";
import { projectSubmission, projectSubmissions } from "../contracts/projection.js";

/**
 * Row Mappers
 */
function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    initials: row.initials || row.name.slice(0, 1)
  };
}

function mapCourse(row) {
  if (!row) return null;
  return {
    id: row.id,
    teacherId: row.teacher_id,
    title: row.title,
    code: row.code,
    color: row.color,
    description: row.description
  };
}

function mapMaterial(row) {
  if (!row) return null;
  const parseErrorCode = row.parse_error_code || undefined;
  const parseError = row.parse_error || undefined;
  return {
    id: row.id,
    courseId: row.course_id,
    ownerId: row.owner_id,
    title: row.title,
    kind: row.kind,
    visibility: row.visibility,
    status: row.status,
    size: row.size,
    pages: row.pages,
    date: row.date,
    sampleKey: row.sample_key || undefined,
    blobId: row.blob_id || undefined,
    knowledge: row.knowledge ? JSON.parse(row.knowledge) : [],
    cards: row.cards ? JSON.parse(row.cards) : [],
    teaching: row.teaching || undefined,
    // task-15：解析结果状态。成功/未解析的课件不带 parseError / parseErrorCode（字段不出现），
    // 只有失败记录才带原因码与可读信息，避免列表里出现一堆 null 噪声。
    parseStatus: deriveParseStatus(row),
    parseErrorCode,
    parseError
  };
}

/**
 * task-15：派生 parseStatus。
 * - 有原因码/原因信息 → failed（如实透出失败，即使 status 列异常也优先报错）
 * - 否则 status === 'ready' → parsed
 * - 其余（pending 且无错误）→ pending（历史遗留的待解析记录，不得谎报 parsed）
 */
function deriveParseStatus(row) {
  if (row.parse_error_code || row.parse_error) return "failed";
  return row.status === "ready" ? "parsed" : "pending";
}

/**
 * task-15：解析错误的写入口径（create / update 共用）。
 * 不变量：`status === 'ready'` 等价于「解析成功」，此时必须清空解析错误，
 * 否则重新解析成功后仍会显示已经不成立的失败原因（陈旧错误）。
 */
function normalizeParseState(status, parseErrorCode, parseError) {
  const code = parseErrorCode || null;
  const message = parseError || null;
  if (!code && !message) return { parseErrorCode: null, parseError: null };
  if (status === "ready") return { parseErrorCode: null, parseError: null };
  return { parseErrorCode: code, parseError: message };
}

function mapAssignment(row) {
  if (!row) return null;
  return {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    due: row.due,
    description: row.description,
    materialIds: row.material_ids ? JSON.parse(row.material_ids) : [],
    rubric: row.rubric ? JSON.parse(row.rubric) : [],
    confirmed: Boolean(row.confirmed),
    published: Boolean(row.published)
  };
}

function mapSubmission(row) {
  if (!row) return null;
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    studentId: row.student_id,
    fileName: row.file_name,
    submittedAt: row.submitted_at,
    status: row.status,
    sampleKey: row.sample_key || undefined,
    blobId: row.blob_id || undefined,
    grades: row.grades ? JSON.parse(row.grades) : [],
    summary: row.summary || "",
    history: row.history ? JSON.parse(row.history) : [],
    failure: row.failure ?? null,
    annotations: row.annotations ? JSON.parse(row.annotations) : [],
    // 解析产物持久化：刷新页面后教师仍能看到报告，不必重新评分
    parsedContent: row.parsed_content ? JSON.parse(row.parsed_content) : null
  };
}

export class DatabaseStore {
  /**
   * @param {string | object} [options] Database file path or configuration object
   */
  constructor(options = {}) {
    const config = typeof options === "string" ? { path: options } : options;
    const dbPath = config.path || ":memory:";
    const shouldSeed = config.seed !== false;

    this.db = new DatabaseSync(dbPath);
    initSchema(this.db);

    if (shouldSeed) {
      seedDatabase(this.db, config.seedData);
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ==========================================
  // Users
  // ==========================================

  getUser(id) {
    const stmt = this.db.prepare("SELECT * FROM users WHERE id = ?");
    const row = stmt.get(id);
    return mapUser(row);
  }

  getUserByUsername(username) {
    const stmt = this.db.prepare("SELECT * FROM users WHERE username = ?");
    const row = stmt.get(username);
    return mapUser(row);
  }

  /**
   * 取登录凭据（含密码哈希），**仅供登录校验内部使用**。
   *
   * 为什么不给 `getUser()` 加字段：`mapUser()` 决定了对外的用户形状，
   * 那些形状会进 API 响应。密码哈希绝不能跟着它出现在任何响应里。
   *
   * @param {string} username
   * @returns {{user: object, passwordHash: string}|null}
   */
  getCredentialByUsername(username) {
    const row = this.db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    if (!row) return null;
    return { user: mapUser(row), passwordHash: row.password_hash || "" };
  }

  /**
   * 设置密码。入参是明文，内部完成哈希，调用方不接触哈希串。
   * @param {string} userId
   * @param {string} password 明文密码
   */
  setUserPassword(userId, password) {
    this.db
      .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(hashPassword(password), userId);
    return this.getUser(userId);
  }

  /**
   * 登录成功：签发并落库一个会话令牌。
   *
   * 令牌由服务端随机生成，`auth.js` 侧校验时也只认库里的记录，
   * 因此调用方无法靠任何入参把身份"说"成别人。
   *
   * @param {string} userId
   * @returns {{token: string, expiresAt: string}}
   */
  createSession(userId) {
    const token = issueToken();
    const expiresAt = sessionExpiry();
    this.db
      .prepare(
        "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
      )
      .run(token, userId, new Date().toISOString(), expiresAt);
    return { token, expiresAt };
  }

  /**
   * 用令牌换回身份。令牌不存在或已过期一律返回 null（过期时顺手删除该记录）。
   *
   * @param {string} token
   * @returns {object|null} 用户对象
   */
  getSessionActor(token) {
    if (typeof token !== "string" || !token.trim()) return null;
    const row = this.db.prepare("SELECT * FROM sessions WHERE token = ?").get(token.trim());
    if (!row) return null;
    if (row.expires_at <= new Date().toISOString()) {
      this.deleteSession(row.token);
      return null;
    }
    return this.getUser(row.user_id);
  }

  /** 退出登录：作废该令牌。 */
  deleteSession(token) {
    this.db.prepare("DELETE FROM sessions WHERE token = ?").run(String(token || ""));
  }

  /** 清理已过期会话，返回清理条数。 */
  pruneExpiredSessions() {
    const info = this.db
      .prepare("DELETE FROM sessions WHERE expires_at <= ?")
      .run(new Date().toISOString());
    return Number(info.changes || 0);
  }

  listUsers() {
    const stmt = this.db.prepare("SELECT * FROM users ORDER BY id ASC");
    return stmt.all().map(mapUser);
  }

  createUser(user) {
    const stmt = this.db.prepare(`
      INSERT INTO users (id, username, name, role, initials)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      user.id,
      user.username,
      user.name,
      user.role,
      user.initials || user.name.slice(0, 1)
    );
    return this.getUser(user.id);
  }

  upsertUser(user) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO users (id, username, name, role, initials)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      user.id,
      user.username,
      user.name,
      user.role,
      user.initials || user.name.slice(0, 1)
    );
    return this.getUser(user.id);
  }

  // ==========================================
  // Courses & Enrollments
  // ==========================================

  getCourse(id) {
    const stmt = this.db.prepare("SELECT * FROM courses WHERE id = ?");
    const row = stmt.get(id);
    return mapCourse(row);
  }

  listCourses() {
    const stmt = this.db.prepare("SELECT * FROM courses ORDER BY code ASC");
    return stmt.all().map(mapCourse);
  }

  createCourse(course) {
    const stmt = this.db.prepare(`
      INSERT INTO courses (id, teacher_id, title, code, color, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      course.id,
      course.teacherId,
      course.title,
      course.code,
      course.color || "blue",
      course.description || ""
    );
    return this.getCourse(course.id);
  }

  enrollStudent(courseId, studentId) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO enrollments (course_id, student_id)
      VALUES (?, ?)
    `);
    stmt.run(courseId, studentId);
  }

  isEnrolled(courseId, studentId) {
    const stmt = this.db.prepare(`
      SELECT 1 FROM enrollments WHERE course_id = ? AND student_id = ?
    `);
    return Boolean(stmt.get(courseId, studentId));
  }

  hasCourse(userId, courseId) {
    const user = this.getUser(userId);
    if (!user) return false;

    if (user.role === "teacher") {
      const stmt = this.db.prepare("SELECT 1 FROM courses WHERE id = ? AND teacher_id = ?");
      return Boolean(stmt.get(courseId, userId));
    }

    return this.isEnrolled(courseId, userId);
  }

  getUserCourses(userId) {
    const user = this.getUser(userId);
    if (!user) return [];

    if (user.role === "teacher") {
      const stmt = this.db.prepare("SELECT * FROM courses WHERE teacher_id = ? ORDER BY code ASC");
      return stmt.all(userId).map(mapCourse);
    } else {
      const stmt = this.db.prepare(`
        SELECT c.* FROM courses c
        JOIN enrollments e ON c.id = e.course_id
        WHERE e.student_id = ?
        ORDER BY c.code ASC
      `);
      return stmt.all(userId).map(mapCourse);
    }
  }

  // ==========================================
  // Materials & Permission Filtering
  // ==========================================

  createMaterial(material) {
    const stmt = this.db.prepare(`
      INSERT INTO materials (
        id, course_id, owner_id, title, kind, visibility, status,
        size, pages, date, sample_key, blob_id, knowledge, cards, teaching,
        parse_error_code, parse_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const status = material.status || "ready";
    const parseState = normalizeParseState(status, material.parseErrorCode, material.parseError);
    stmt.run(
      material.id,
      material.courseId,
      material.ownerId,
      material.title,
      material.kind || "PDF",
      material.visibility || "course",
      status,
      material.size || "0 KB",
      material.pages || 1,
      material.date || new Date().toISOString().slice(0, 10),
      material.sampleKey || null,
      material.blobId || null,
      JSON.stringify(material.knowledge || []),
      JSON.stringify(material.cards || []),
      material.teaching || null,
      parseState.parseErrorCode,
      parseState.parseError
    );
    return this.getMaterialById(material.id);
  }

  getMaterialById(id, userId = null) {
    const stmt = this.db.prepare("SELECT * FROM materials WHERE id = ?");
    const row = stmt.get(id);
    if (!row) return null;
    const material = mapMaterial(row);

    if (userId) {
      const user = this.getUser(userId);
      if (!user) return null;
      if (!this.hasCourse(userId, material.courseId)) return null;
      // canSeeMaterial: must be course visibility or owned by user
      if (material.visibility !== "course" && material.ownerId !== userId) {
        return null;
      }
    }

    return material;
  }

  /**
   * 严格实现师生权限过滤逻辑：
   * getMaterials(userId, courseId):
   * 学生仅能看到本课程公开资料 + 自己私有资料；
   * 教师同样需具有该课程权限，能看到公开资料及自己创建的私有资料。
   */
  getMaterials(userId, courseId) {
    const user = this.getUser(userId);
    if (!user) return [];

    // 必须有该课程访问权限（学生已选课或教师授课）
    if (courseId && !this.hasCourse(userId, courseId)) {
      return [];
    }

    if (courseId) {
      const stmt = this.db.prepare(`
        SELECT * FROM materials
        WHERE course_id = ?
          AND (visibility = 'course' OR owner_id = ?)
        ORDER BY date DESC, id ASC
      `);
      return stmt.all(courseId, userId).map(mapMaterial);
    } else {
      // 获取用户所有已加入课程的资料
      const courses = this.getUserCourses(userId);
      if (!courses.length) return [];
      const courseIds = courses.map(c => c.id);
      const placeholders = courseIds.map(() => "?").join(",");
      const stmt = this.db.prepare(`
        SELECT * FROM materials
        WHERE course_id IN (${placeholders})
          AND (visibility = 'course' OR owner_id = ?)
        ORDER BY date DESC, id ASC
      `);
      return stmt.all(...courseIds, userId).map(mapMaterial);
    }
  }

  updateMaterial(id, patch) {
    const existing = this.getMaterialById(id);
    if (!existing) return null;

    const merged = { ...existing, ...patch };
    // task-15：重新解析成功（status=ready）必须清掉陈旧错误；显式传 null 也走同一口径
    const parseState = normalizeParseState(merged.status, merged.parseErrorCode, merged.parseError);
    const stmt = this.db.prepare(`
      UPDATE materials SET
        course_id = ?,
        owner_id = ?,
        title = ?,
        kind = ?,
        visibility = ?,
        status = ?,
        size = ?,
        pages = ?,
        date = ?,
        sample_key = ?,
        blob_id = ?,
        knowledge = ?,
        cards = ?,
        teaching = ?,
        parse_error_code = ?,
        parse_error = ?
      WHERE id = ?
    `);
    stmt.run(
      merged.courseId,
      merged.ownerId,
      merged.title,
      merged.kind,
      merged.visibility,
      merged.status,
      merged.size,
      merged.pages,
      merged.date,
      merged.sampleKey || null,
      merged.blobId || null,
      JSON.stringify(merged.knowledge || []),
      JSON.stringify(merged.cards || []),
      merged.teaching || null,
      parseState.parseErrorCode,
      parseState.parseError,
      id
    );
    return this.getMaterialById(id);
  }

  deleteMaterial(id) {
    const stmt = this.db.prepare("DELETE FROM materials WHERE id = ?");
    stmt.run(id);
  }

  listMaterials() {
    const stmt = this.db.prepare("SELECT * FROM materials ORDER BY date DESC, id ASC");
    return stmt.all().map(mapMaterial);
  }

  // ==========================================
  // Assignments & Permission Filtering
  // ==========================================

  createAssignment(assignment) {
    const stmt = this.db.prepare(`
      INSERT INTO assignments (
        id, course_id, title, due, description, material_ids, rubric, confirmed, published
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      assignment.id,
      assignment.courseId,
      assignment.title,
      assignment.due || "",
      assignment.description || "",
      JSON.stringify(assignment.materialIds || []),
      JSON.stringify(assignment.rubric || []),
      assignment.confirmed ? 1 : 0,
      assignment.published ? 1 : 0
    );
    return this.getAssignment(assignment.id);
  }

  getAssignment(id, userId = null) {
    const stmt = this.db.prepare("SELECT * FROM assignments WHERE id = ?");
    const row = stmt.get(id);
    if (!row) return null;
    const assignment = mapAssignment(row);

    if (userId) {
      const user = this.getUser(userId);
      if (!user) return null;
      if (!this.hasCourse(userId, assignment.courseId)) return null;
      // 学生仅能看到 published 的作业
      if (user.role === "student" && !assignment.published) {
        return null;
      }
    }

    return assignment;
  }

  getAssignments(userId, courseId) {
    const user = this.getUser(userId);
    if (!user) return [];

    if (courseId && !this.hasCourse(userId, courseId)) {
      return [];
    }

    if (courseId) {
      if (user.role === "teacher") {
        const stmt = this.db.prepare("SELECT * FROM assignments WHERE course_id = ? ORDER BY due ASC, id ASC");
        return stmt.all(courseId).map(mapAssignment);
      } else {
        const stmt = this.db.prepare("SELECT * FROM assignments WHERE course_id = ? AND published = 1 ORDER BY due ASC, id ASC");
        return stmt.all(courseId).map(mapAssignment);
      }
    } else {
      const courses = this.getUserCourses(userId);
      if (!courses.length) return [];
      const courseIds = courses.map(c => c.id);
      const placeholders = courseIds.map(() => "?").join(",");
      if (user.role === "teacher") {
        const stmt = this.db.prepare(`SELECT * FROM assignments WHERE course_id IN (${placeholders}) ORDER BY due ASC, id ASC`);
        return stmt.all(...courseIds).map(mapAssignment);
      } else {
        const stmt = this.db.prepare(`SELECT * FROM assignments WHERE course_id IN (${placeholders}) AND published = 1 ORDER BY due ASC, id ASC`);
        return stmt.all(...courseIds).map(mapAssignment);
      }
    }
  }

  updateAssignment(id, patch) {
    const existing = this.getAssignment(id);
    if (!existing) return null;

    const merged = { ...existing, ...patch };
    const stmt = this.db.prepare(`
      UPDATE assignments SET
        course_id = ?,
        title = ?,
        due = ?,
        description = ?,
        material_ids = ?,
        rubric = ?,
        confirmed = ?,
        published = ?
      WHERE id = ?
    `);
    stmt.run(
      merged.courseId,
      merged.title,
      merged.due || "",
      merged.description || "",
      JSON.stringify(merged.materialIds || []),
      JSON.stringify(merged.rubric || []),
      merged.confirmed ? 1 : 0,
      merged.published ? 1 : 0,
      id
    );
    return this.getAssignment(id);
  }

  // ==========================================
  // Submissions & Permission Filtering
  // ==========================================

  createSubmission(submission) {
    const stmt = this.db.prepare(`
      INSERT INTO submissions (
        id, assignment_id, student_id, file_name, submitted_at, status,
        sample_key, blob_id, grades, summary, history, failure, annotations
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      submission.id,
      submission.assignmentId,
      submission.studentId,
      submission.fileName,
      submission.submittedAt || new Date().toISOString(),
      submission.status || "submitted",
      submission.sampleKey || null,
      submission.blobId || null,
      JSON.stringify(submission.grades || []),
      submission.summary || "",
      JSON.stringify(submission.history || []),
      submission.failure || null,
      JSON.stringify(submission.annotations || [])
    );
    return this.getSubmission(submission.id);
  }

  getSubmission(id, userId = null) {
    const stmt = this.db.prepare("SELECT * FROM submissions WHERE id = ?");
    const row = stmt.get(id);
    if (!row) return null;
    const submission = mapSubmission(row);

    if (userId) {
      const user = this.getUser(userId);
      if (!user) return null;

      const assignment = this.getAssignment(submission.assignmentId);
      if (!assignment) return null;

      if (user.role === "teacher") {
        if (!this.hasCourse(userId, assignment.courseId)) return null;
        // 字段裁剪交给投影契约统一决定（见 src/contracts/projection.js）
        return projectSubmission(submission, user);
      }

      // 学生只能看自己的提交
      if (submission.studentId !== userId) return null;
      if (!this.hasCourse(userId, assignment.courseId)) return null;

      // D2：未发布时学生不得看到分数与评语。
      // 这里**不再手写黑名单**——原先只清 grades/summary，漏掉了 history
      // （history 里装着历次评分的 grades 与 summary），等于留了一条泄漏通道。
      return projectSubmission(submission, user);
    }

    return submission;
  }

  /**
   * 严格实现师生权限过滤逻辑：
   * getSubmissions(userId, assignmentId):
   * 教师能看全班；学生仅能看自己的。
   *
   * **字段裁剪一律交给投影契约**（`projectSubmissions`）：
   * 它在服务端一处决定「谁看到什么」，避免各调用点各写一套规则而出现漏项。
   */
  getSubmissions(userId, assignmentId) {
    const user = this.getUser(userId);
    if (!user) return [];

    const assignment = this.getAssignment(assignmentId);
    if (!assignment) return [];

    // 验证用户是否有该作业所属课程权限
    if (!this.hasCourse(userId, assignment.courseId)) {
      return [];
    }

    const rows =
      user.role === "teacher"
        ? this.db
            .prepare(
              "SELECT * FROM submissions WHERE assignment_id = ? ORDER BY submitted_at DESC, id ASC"
            )
            .all(assignmentId)
        : this.db
            .prepare(
              "SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ? ORDER BY submitted_at DESC, id ASC"
            )
            .all(assignmentId, userId);

    return projectSubmissions(rows.map(mapSubmission), user);
  }

  listSubmissions(assignmentId = null) {
    if (assignmentId) {
      const stmt = this.db.prepare(`
        SELECT * FROM submissions
        WHERE assignment_id = ?
        ORDER BY submitted_at DESC, id ASC
      `);
      return stmt.all(assignmentId).map(mapSubmission);
    }
    const stmt = this.db.prepare(`
      SELECT * FROM submissions
      ORDER BY submitted_at DESC, id ASC
    `);
    return stmt.all().map(mapSubmission);
  }

  getReviewDraft(submissionId) {
    const row = this.db.prepare("SELECT * FROM review_drafts WHERE submission_id = ?").get(submissionId);
    if (!row) return null;
    return {
      submissionId: row.submission_id,
      teacherId: row.teacher_id,
      grades: JSON.parse(row.grades),
      summary: row.summary,
      version: row.version,
      baseReviewVersion: row.base_review_version,
      updatedAt: row.updated_at
    };
  }

  saveReviewDraft(submissionId, teacherId, grades, summary, expectedVersion, baseReviewVersion) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const submission = this.getSubmission(submissionId);
      if (!submission || submission.history.length !== baseReviewVersion) {
        const error = new Error("正式成绩已更新，请刷新后再编辑草稿。");
        error.code = "DRAFT_CONFLICT";
        throw error;
      }
      const current = this.getReviewDraft(submissionId);
      if ((current?.version || 0) !== expectedVersion) {
        const error = new Error("这份草稿已在其他页面更新，请刷新后再编辑。");
        error.code = "DRAFT_CONFLICT";
        throw error;
      }
      const version = expectedVersion + 1;
      const updatedAt = new Date().toISOString();
      if (current) {
        this.db.prepare(`UPDATE review_drafts SET teacher_id = ?, grades = ?, summary = ?, version = ?, base_review_version = ?, updated_at = ? WHERE submission_id = ?`)
          .run(teacherId, JSON.stringify(grades), summary, version, baseReviewVersion, updatedAt, submissionId);
      } else {
        this.db.prepare(`INSERT INTO review_drafts (submission_id, teacher_id, grades, summary, version, base_review_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(submissionId, teacherId, JSON.stringify(grades), summary, version, baseReviewVersion, updatedAt);
      }
      this.db.exec("COMMIT");
      return this.getReviewDraft(submissionId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  clearReviewDraft(submissionId) {
    this.db.prepare("DELETE FROM review_drafts WHERE submission_id = ?").run(submissionId);
  }

  updateSubmission(id, patch) {
    const existing = this.getSubmission(id);
    if (!existing) return null;

    const merged = { ...existing, ...patch };
    const stmt = this.db.prepare(`
      UPDATE submissions SET
        assignment_id = ?,
        student_id = ?,
        file_name = ?,
        submitted_at = ?,
        status = ?,
        sample_key = ?,
        blob_id = ?,
        grades = ?,
        summary = ?,
        history = ?,
        failure = ?,
        annotations = ?,
        parsed_content = ?
      WHERE id = ?
    `);
    stmt.run(
      merged.assignmentId,
      merged.studentId,
      merged.fileName,
      merged.submittedAt,
      merged.status,
      merged.sampleKey || null,
      merged.blobId || null,
      JSON.stringify(merged.grades || []),
      merged.summary || "",
      JSON.stringify(merged.history || []),
      merged.failure || null,
      JSON.stringify(merged.annotations || []),
      merged.parsedContent ? JSON.stringify(merged.parsedContent) : null,
      id
    );
    return this.getSubmission(id);
  }

  publishReview(submissionId, teacherId, grades, summary) {
    const submission = this.getSubmission(submissionId);
    if (!submission) throw new Error("报告不存在。");

    const assignment = this.getAssignment(submission.assignmentId);
    if (!assignment) throw new Error("作业不存在。");

    const teacher = this.getUser(teacherId);
    if (!teacher || teacher.role !== "teacher" || !this.hasCourse(teacherId, assignment.courseId)) {
      throw new Error("仅本课程教师可以操作。");
    }

    if (!assignment.confirmed) {
      throw new Error("请先确认评分标准。");
    }

    if (submission.status === "grading") {
      throw new Error("请等待评阅结束。");
    }

    const newHistory = [
      ...submission.history,
      {
        confirmedAt: new Date().toISOString(),
        grades: structuredClone(grades),
        summary
      }
    ];

    return this.updateSubmission(submissionId, {
      status: "published",
      grades,
      summary,
      history: newHistory
    });
  }
}

export function createDatabaseStore(options) {
  return new DatabaseStore(options);
}

export default DatabaseStore;
