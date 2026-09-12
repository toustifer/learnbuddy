import { createId } from "../id";
import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileUp,
  LockKeyhole,
  Plus,
  Search,
  Upload,
  X,
  Info,
} from "lucide-react";
import { useStore } from "../store-context";
import { validateFile, visibleCourses, visibleMaterials } from "../domain";
import { Button, IconButton, Popover, Select, TextField, Tooltip } from "@radix-ui/themes";
import { AnimatePresence, motion } from "motion/react";
import { LIVE_MODE, uploadMaterial, parseErrorText } from "../api";
import { saveBlob } from "../storage";
import {
  Empty,
  FileIcon,
  Modal,
  Status,
  formatFileSize,
} from "../ui";
import type { Material } from "../types";

export function UploadMaterial({ onClose, initialVisibility, scope }: { onClose: () => void; initialVisibility?: "course" | "private"; scope?: string }) {
  const { user, courseId, update, notify, refreshMaterials } = useStore();
  const myCourses = visibleCourses(user!);
  const [target, setTarget] = useState(
    scope || (courseId === "all" ? myCourses[0]?.id || "" : courseId),
  );
  const [visibility, setVisibility] = useState<"course" | "private">(
    user!.role === "teacher" ? initialVisibility || "course" : "private",
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
        const id = createId();
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
      title={visibility === "course" ? "发布课程资料" : user!.role === "teacher" ? "添加备课文件" : "添加个人参考资料"}
      description={visibility === "course" ? "上传课件或讲义，供本课程师生阅读。" : "补充课外阅读、笔记或参考文档，供自己阅读和向助手提问。文件仅自己可见。"}
      onClose={() => !saving && onClose()}
    >
      <div className="form-grid">
        <label>
          所属课程
          <Select.Root value={target} onValueChange={setTarget}><Select.Trigger aria-label="所属课程" /><Select.Content>{myCourses.map((c) => <Select.Item value={c.id} key={c.id}>{c.title}</Select.Item>)}</Select.Content></Select.Root>
        </label>
        <label>
          谁可以看见
          <Select.Root value={visibility} disabled={user!.role === "student"} onValueChange={(value) => setVisibility(value as "course" | "private")}><Select.Trigger aria-label="谁可以看见" /><Select.Content><Select.Item value="course">本课程师生</Select.Item><Select.Item value="private">仅自己</Select.Item></Select.Content></Select.Root>
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
export function Library({ scope }: { scope: string }) {
  const { state, user, go, materialsLoading, materialsError, refreshMaterials } = useStore();
  const teacher = user!.role === "teacher";
  const [upload, setUpload] = useState<"course" | "private" | null>(null);
  const [search, setSearch] = useState("");
  const [personalOpen, setPersonalOpen] = useState(false);
  useEffect(() => { setSearch(""); setPersonalOpen(false); }, [scope]);
  const all = visibleMaterials(state, user!).filter((m) => m.courseId === scope);
  const matches = (m: Material) => m.title.toLowerCase().includes(search.toLowerCase());
  const materials = all.filter((m) => m.visibility === "course" && matches(m));
  const personal = all.filter((m) => m.visibility === "private" && matches(m));
  function rows(items: Material[]) {
    return <div className="resource-list">{items.map((m) => <button className="resource-row" key={m.id} onClick={() => go({ page: "material", id: m.id })}>
      <FileIcon kind={m.kind} /><span className="resource-name"><strong>{m.title}</strong><small>{m.kind} · {m.size}{m.pages ? ` · ${m.pages} 页` : ""}{m.sampleKey ? " · 教学样例" : ""}</small></span>
      <span className="resource-state">{LIVE_MODE && m.status !== "ready" ? <span className="status orange" title={parseErrorText(m)}>{m.parseStatus === "failed" ? "解析失败" : "未完成解析"}</span> : <Status status={m.status} />}</span>
      <span className="resource-date">{m.date.slice(5).replace("-", "/")}</span><ChevronRight size={17} />
    </button>)}</div>;
  }
  return <section className="course-resources">
    <div className="resource-heading"><div><h2>课程资料<span className="heading-count">{materials.length}</span></h2><p>{teacher ? "本课程师生可见的课件与讲义。" : "老师发布的课件与讲义，打开即可阅读和提问。"}</p></div>
      {teacher && <Button onClick={() => setUpload("course")}><Plus size={16} />发布资料</Button>}
    </div>
    <div className="resource-search"><TextField.Root placeholder="搜索本课程资料…" aria-label="搜索本课程资料" value={search} onChange={(e) => setSearch(e.target.value)}><TextField.Slot><Search size={16} /></TextField.Slot>{search && <TextField.Slot><IconButton size="1" variant="ghost" color="gray" aria-label="清空搜索" onClick={() => setSearch("")}><X size={13} /></IconButton></TextField.Slot>}</TextField.Root><span>{materials.length} 份课程资料</span></div>
    {materialsError ? <Empty title="暂时无法读取资料" description={materialsError} action={<Button variant="soft" onClick={() => void refreshMaterials()}>重新加载</Button>} />
      : materialsLoading && !all.length ? <Empty title="正在读取课程资料…" />
      : materials.length ? rows(materials) : <Empty title={search ? "没有找到匹配的课程资料" : "老师还没有发布资料"} description={search ? "试试其他关键词。" : teacher ? "发布课件后，学生可在这里阅读。" : "老师发布课件后，会出现在这里。"} />}
    <section className="personal-resources">
      <div className="personal-heading"><button onClick={() => setPersonalOpen(!personalOpen)} aria-expanded={personalOpen} aria-controls="personal-resources-list"><motion.span animate={{ rotate: personalOpen ? 0 : -90 }}><ChevronDown size={16} /></motion.span><LockKeyhole size={14} /><span>{teacher ? "我的备课文件" : "个人参考资料"}</span><span className="heading-count">{personal.length}</span></button>
        <Popover.Root><Popover.Trigger><IconButton variant="ghost" color="gray" size="1" aria-label="个人资料有什么用"><Info size={15} /></IconButton></Popover.Trigger><Popover.Content maxWidth="280px"><p className="resource-explanation">{teacher ? "放自己的备课笔记、参考文献。不会自动发布给学生。" : "需要结合课外文档、阅读笔记提问时，可以在这里添加文件。它们不是课程作业，也不会分享给老师或同学。"}</p></Popover.Content></Popover.Root>
        <Tooltip content={teacher ? "添加仅自己可见的备课文件" : "添加课外参考文件，仅自己可见"}><Button size="1" variant="ghost" color="gray" onClick={() => { setPersonalOpen(true); setUpload("private"); }}><Plus size={14} />添加文件</Button></Tooltip>
      </div>
      <AnimatePresence initial={false}>{personalOpen && <motion.div id="personal-resources-list" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: .2 }} className="personal-content"><p>{teacher ? "备课笔记、参考文献，仅自己可见。" : "课外文档、阅读笔记，可交给助手一起阅读；仅自己可见。"}</p>{personal.length ? rows(personal) : <div className="personal-empty">{search ? "没有匹配的个人资料。" : "有需要时再添加，日常学习直接阅读上方课程资料即可。"}</div>}</motion.div>}</AnimatePresence>
    </section>
    {upload && <UploadMaterial scope={scope} initialVisibility={upload} onClose={() => setUpload(null)} />}
  </section>;
}
