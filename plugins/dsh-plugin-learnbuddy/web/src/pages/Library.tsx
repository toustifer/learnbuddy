import { useRef, useState } from "react";
import {
  ArrowRight,
  ChevronRight,
  FileUp,
  LockKeyhole,
  Plus,
  Search,
  Upload,
} from "lucide-react";
import { useStore } from "../store-context";
import { validateFile, visibleCourses, visibleMaterials } from "../domain";
import { courses, users } from "../seed";
import { saveBlob } from "../storage";
import {
  CourseBadge,
  Empty,
  FileIcon,
  MiniArt,
  Modal,
  PageHeading,
  SectionHeading,
  Status,
  formatFileSize,
} from "../ui";
import type { Material } from "../types";

export function UploadMaterial({ onClose }: { onClose: () => void }) {
  const { user, courseId, update, notify } = useStore();
  const myCourses = visibleCourses(user!);
  const [target, setTarget] = useState(
    courseId === "all" ? myCourses[0].id : courseId,
  );
  const [visibility, setVisibility] = useState<"course" | "private">(
    user!.role === "teacher" ? "course" : "private",
  );
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  function select(incoming: FileList | File[]) {
    try {
      const next = Array.from(incoming);
      next.forEach(validateFile);
      setFiles(next);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function submit() {
    if (!files.length) return setError("请先选择文件。");
    setSaving(true);
    try {
      const next: Material[] = [];
      for (const file of files) {
        const kind = validateFile(file);
        const id = crypto.randomUUID();
        await saveBlob(id, file);
        next.push({
          id,
          blobId: id,
          courseId: target,
          ownerId: user!.id,
          title: file.name,
          kind,
          visibility: user!.role === "student" ? "private" : visibility,
          status: "pending",
          size: formatFileSize(file.size),
          date: new Date().toISOString().slice(0, 10),
          knowledge: [],
          cards: [],
        });
      }
      update((s) => ({ ...s, materials: [...next, ...s.materials] }));
      notify(`已保存 ${next.length} 份文件，真实解析待接入。`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title="添加课程资料"
      description="课件、讲义或你的课堂笔记，都可以放在这里。"
      onClose={() => !saving && onClose()}
    >
      <div className="form-grid">
        <label>
          所属课程
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {myCourses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          谁可以看见
          <select
            value={visibility}
            disabled={user!.role === "student"}
            onChange={(e) =>
              setVisibility(e.target.value as "course" | "private")
            }
          >
            <option value="course">本课程师生</option>
            <option value="private">仅自己</option>
          </select>
        </label>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept=".pdf,.ppt,.pptx,.docx,.png,.jpg,.jpeg"
        onChange={(e) => e.target.files && select(e.target.files)}
      />
      <button
        className={"dropzone " + (drag ? "drag" : "")}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          select(e.dataTransfer.files);
        }}
      >
        <span className="upload-icon">
          <FileUp size={26} />
        </span>
        <strong>
          {files.length
            ? `已选择 ${files.length} 份文件`
            : "点击选择，或拖入文件"}
        </strong>
        <span>PDF、PPT / PPTX、DOCX、PNG、JPG</span>
        <small>单个文件最大 20 MB · 可同时选择多个</small>
      </button>
      {files.length > 0 && (
        <div className="upload-list">
          {files.map((f, i) => (
            <div key={i}>
              <FileIcon kind={f.name.split(".").pop()!.toUpperCase()} />
              <span>{f.name}</span>
              <small>{formatFileSize(f.size)}</small>
            </div>
          ))}
        </div>
      )}
      <p className="inline-note">
        文件保存在当前浏览器。PDF
        和图片支持原文预览；文档转换、图文解析与知识点提取将在后端接入后可用。
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <button
          className="button secondary"
          onClick={onClose}
          disabled={saving}
        >
          取消
        </button>
        <button
          className="button primary"
          disabled={saving || !files.length}
          onClick={() => void submit()}
        >
          <Upload size={15} />
          {saving ? "正在保存…" : "添加资料"}
        </button>
      </div>
    </Modal>
  );
}
export function Library() {
  const { state, user, go, courseId, setCourseId } = useStore();
  const [upload, setUpload] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const myCourses = visibleCourses(user!);
  const all = visibleMaterials(state, user!);
  const materials = all.filter(
    (m) =>
      (courseId === "all" || m.courseId === courseId) &&
      m.title.toLowerCase().includes(search.toLowerCase()) &&
      (filter === "all" ||
        (filter === "private"
          ? m.visibility === "private"
          : m.visibility === "course")),
  );
  const course = courses.find((c) => c.id === courseId);
  const pinned = all.find((m) => m.id === "mat-tcp") || all[0];
  return (
    <div className="page library-page">
      <PageHeading
        eyebrow={
          user!.role === "teacher"
            ? "TEACHING, WITH CLARITY"
            : "A LITTLE MORE UNDERSTANDING"
        }
        title={course ? course.title : "课程资料"}
        description={
          user!.role === "teacher"
            ? "把材料整理好，让每一次讲解都有据可依。"
            : "你的课件、笔记与问题，在这里慢慢连成知识。"
        }
        action={
          <button className="button primary" onClick={() => setUpload(true)}>
            <Plus size={16} />
            添加资料
          </button>
        }
      />
      <div className="course-cards">
        {myCourses
          .filter((c) => !course || c.id === courseId)
          .map((c) => (
            <button
              key={c.id}
              className={
                "course-card " +
                c.color +
                (courseId === c.id ? " selected" : "")
              }
              onClick={() => setCourseId(courseId === c.id ? "all" : c.id)}
            >
              <span className="course-card-code">
                {c.code}
                <ChevronRight size={14} />
              </span>
              <strong>{c.title}</strong>
              <p>{c.description}</p>
              <div className="course-card-footer">
                <span>
                  {all.filter((m) => m.courseId === c.id).length} 份资料
                </span>
                <span className="dot-separator" />
                <span>
                  {users.find((u) => u.id === c.teacherId)!.name} 老师
                </span>
              </div>
              <MiniArt variant={c.id} />
            </button>
          ))}
      </div>
      {pinned && courseId === "all" && (
        <button
          className="continue-strip"
          onClick={() => go({ page: "material", id: pinned.id })}
        >
          <span className="continue-icon">
            <FileIcon kind={pinned.kind} />
          </span>
          <span>
            <small>
              {user!.role === "teacher" ? "准备下一次课堂" : "从这里开始阅读"}
            </small>
            <strong>{pinned.title}</strong>
          </span>
          <span className="continue-meta">原文 · 知识点 · 学习助手</span>
          <span className="continue-link">
            打开工作台
            <ArrowRight size={15} />
          </span>
        </button>
      )}
      <SectionHeading
        title={course ? "课程材料" : "所有资料"}
        count={materials.length}
      />
      <div className="list-toolbar">
        <div className="tabs">
          <button
            className={filter === "all" ? "active" : ""}
            onClick={() => setFilter("all")}
          >
            全部
          </button>
          <button
            className={filter === "course" ? "active" : ""}
            onClick={() => setFilter("course")}
          >
            课程共享
          </button>
          <button
            className={filter === "private" ? "active" : ""}
            onClick={() => setFilter("private")}
          >
            <LockKeyhole size={12} />
            仅自己
          </button>
        </div>
        <div className="search-field compact">
          <Search size={15} />
          <input
            aria-label="筛选资料"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索资料…"
          />
          {search && (
            <button onClick={() => setSearch("")} aria-label="清空搜索">
              ×
            </button>
          )}
        </div>
      </div>
      <div className="material-table">
        {" "}
        <div className="material-table-head">
          <span>资料名称</span>
          <span>所属课程</span>
          <span>状态</span>
          <span>更新日期</span>
          <span />
        </div>
        {materials.map((m) => (
          <div className="material-row" key={m.id}>
            <button
              className="file-name"
              onClick={() => go({ page: "material", id: m.id })}
            >
              <FileIcon kind={m.kind} />
              <span>
                <strong>{m.title}</strong>
                <small>
                  {m.kind} · {m.size}
                  {m.visibility === "private" && (
                    <>
                      {" "}
                      · <LockKeyhole size={10} />
                      仅自己
                    </>
                  )}
                  {m.sampleKey && " · 示例"}
                </small>
              </span>
            </button>
            <CourseBadge id={m.courseId} />
            <Status status={m.status} />
            <span className="file-date">
              {m.date.slice(5).replace("-", "月")}日
            </span>
            <button
              className="icon-button row-open"
              aria-label={"打开" + m.title}
              onClick={() => go({ page: "material", id: m.id })}
            >
              <ChevronRight size={17} />
            </button>
          </div>
        ))}
      </div>
      {!materials.length && (
        <Empty
          title={search ? "没有找到匹配资料" : "这里还没有资料"}
          description={
            search
              ? "试试其他关键词，或清空筛选。"
              : "添加本课程的课件或笔记，开始整理与学习。"
          }
          action={
            <button
              className="button secondary"
              onClick={() => (search ? setSearch("") : setUpload(true))}
            >
              {search ? "清空搜索" : "添加资料"}
            </button>
          }
        />
      )}
      <div className="list-footer">
        <span>
          <LockKeyhole size={12} />
          个人上传的资料仅自己可见；教师共享资料对本课程开放。
        </span>
        <span>{materials.length} 份资料</span>
      </div>
      {upload && <UploadMaterial onClose={() => setUpload(false)} />}
    </div>
  );
}
