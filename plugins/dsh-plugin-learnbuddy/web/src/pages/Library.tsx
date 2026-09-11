import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronRight,
  FileUp,
  LockKeyhole,
  Plus,
  Search,
  Upload,
  X,
} from "lucide-react";
import { useStore } from "../store-context";
import { validateFile, visibleCourses, visibleMaterials } from "../domain";
import { courses } from "../seed";
import { LIVE_MODE, uploadMaterial, parseErrorText } from "../api";
import { saveBlob } from "../storage";
import {
  CourseBadge,
  Empty,
  FileIcon,
  Modal,
  PageHeading,
  SectionHeading,
  Status,
  formatFileSize,
} from "../ui";
import type { Material } from "../types";

export function UploadMaterial({ onClose }: { onClose: () => void }) {
  const { user, courseId, update, notify, refreshMaterials } = useStore();
  const myCourses = visibleCourses(user!);
  const [target, setTarget] = useState(
    courseId === "all" ? myCourses[0]?.id || "" : courseId,
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
    if (!target) return setError("请先选择所属课程。");
    setSaving(true);
    try {
      if (LIVE_MODE) {
        let count = 0;
        try {
          for (const file of files) {
            await uploadMaterial(file, user!, target, visibility);
            count++;
            setFiles((remaining) => remaining.filter((f) => f !== file));
          }
        } finally {
          await refreshMaterials();
        }
        notify(`已上传 ${count} 份资料，请查看各文件的解析状态。`);
        onClose();
        return;
      }
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
        {LIVE_MODE
          ? "上传后由服务器保存和解析。解析失败时保留原件，并显示具体原因。"
          : "文件保存在当前浏览器，真实解析未接入。"}
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
  const {
    state,
    user,
    go,
    courseId,
    materialsLoading,
    materialsError,
    refreshMaterials,
  } = useStore();
  const [upload, setUpload] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  useEffect(() => {
    setSearch("");
    setFilter("all");
  }, [courseId]);
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
  let lastRead = "";
  try {
    lastRead =
      localStorage.getItem(`learnbuddy-recent:${LIVE_MODE}:${user!.id}`) || "";
  } catch {
    /* optional preference */
  }
  const pinned = all.find((m) => m.id === lastRead);
  if (LIVE_MODE && materialsLoading && !all.length)
    return (
      <div className="page">
        <Empty title="正在读取课程资料…" />
      </div>
    );
  if (LIVE_MODE && materialsError)
    return (
      <div className="page">
        <Empty
          title="暂时无法读取资料"
          description={materialsError}
          action={
            <button
              className="button secondary"
              onClick={() => void refreshMaterials()}
            >
              重新加载
            </button>
          }
        />
      </div>
    );
  return (
    <div className="page library-page">
      <PageHeading
        eyebrow={
          user!.role === "teacher"
            ? "TEACHING, WITH CLARITY"
            : "A LITTLE MORE UNDERSTANDING"
        }
        title={user!.role === "teacher" ? "教学资料" : "课程学习"}
        description={
          user!.role === "teacher"
            ? "管理课程课件、备课提纲与答疑内容。"
            : "阅读课程资料，整理笔记，向学习助手提问。"
        }
        action={
          <button className="button primary" onClick={() => setUpload(true)}>
            <Plus size={16} />
            {user!.role === "teacher" ? "上传教学资料" : "上传我的笔记"}
          </button>
        }
      />
      {pinned && user!.role === "student" && (courseId === "all" || pinned.courseId === courseId) && (
        <button
          className="continue-strip"
          onClick={() => go({ page: "material", id: pinned.id })}
        >
          <span className="continue-icon">
            <FileIcon kind={pinned.kind} />
          </span>
          <span>
            <small>继续上次阅读</small>
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
        title={course ? course.title : "课程资料"}
        count={materials.length}
      />
      <div className="list-toolbar">
        <div className="tabs">
          <button
            className={filter === "all" ? "active" : ""}
            onClick={() => setFilter("all")}
          >
            全部资料
          </button>
          <button
            className={filter === "course" ? "active" : ""}
            onClick={() => setFilter("course")}
          >
            {user!.role === "teacher" ? "已共享课件" : "老师共享"}
          </button>
          <button
            className={filter === "private" ? "active" : ""}
            onClick={() => setFilter("private")}
          >
            <LockKeyhole size={12} />
            {user!.role === "teacher" ? "个人备课" : "我的笔记"}
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
              <X size={14} />
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
                      {user!.role === "teacher" ? "个人备课" : "我的笔记"}
                    </>
                  )}
                  {m.sampleKey && " · 教学样例"}
                </small>
              </span>
            </button>
            <CourseBadge id={m.courseId} />
            {LIVE_MODE && m.status !== "ready" ? (
              <span className="status orange" title={parseErrorText(m)}>
                {m.parseStatus === "failed" ? "解析失败" : "未完成解析"}
              </span>
            ) : (
              <Status status={m.status} />
            )}
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
          {user!.role === "teacher" ? "共享课件对课程师生开放，个人备课仅自己可见。" : "你上传的笔记仅自己可见。"}
        </span>
        <span>{materials.length} 份资料</span>
      </div>
      {upload && <UploadMaterial onClose={() => setUpload(false)} />}
    </div>
  );
}
