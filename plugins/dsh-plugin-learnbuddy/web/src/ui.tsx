import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  Layers,
  LoaderCircle,
  Monitor,
  X,
  Sparkles,
  LockKeyhole,
} from "lucide-react";
import { courses } from "./seed";
import { getBlob } from "./storage";
import type { Material, Submission } from "./types";

export function Brand({ small = false }: { small?: boolean }) {
  return (
    <span className={"brand " + (small ? "small" : "")}>
      <span className="brand-mark">
        <svg viewBox="0 0 28 28" aria-hidden="true">
          <path
            d="M6 7c6 0 8 3 8 9v6C8 22 4 19 4 13V7h2Z"
            fill="currentColor"
            opacity=".65"
          />
          <path
            d="M22 4c-7 0-10 4-10 11v7c7 0 12-4 12-11V4h-2Z"
            fill="currentColor"
          />
          <path
            d="m12 21 6-10"
            stroke="white"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </span>
      {!small && (
        <span>
          LearnBuddy<span className="brand-dot">.</span>
        </span>
      )}
    </span>
  );
}
export function CourseBadge({ id }: { id: string }) {
  const c = courses.find((c) => c.id === id) || { title: id, color: "green" };
  return (
    <span className={"course-badge " + c.color}>
      <span className="course-dot" />
      {c.title}
    </span>
  );
}
export function FileIcon({
  kind,
  large = false,
}: {
  kind: string;
  large?: boolean;
}) {
  const Icon = ["PNG", "JPG"].includes(kind)
    ? ImageIcon
    : kind.startsWith("PPT")
      ? Monitor
      : FileText;
  return (
    <span
      className={"file-icon " + kind.toLowerCase() + (large ? " large" : "")}
    >
      <Icon size={large ? 28 : 20} />
      {large && <small>{kind}</small>}
    </span>
  );
}
export function Status({
  status,
}: {
  status: Submission["status"] | Material["status"] | "draft";
}) {
  const map = {
    ready: ["已整理", "green"],
    pending: ["待接入解析", "gray"],
    submitted: ["待评阅", "orange"],
    grading: ["评阅中", "purple"],
    review: ["待教师复核", "orange"],
    published: ["已反馈", "green"],
    failed: ["需处理", "red"],
    draft: ["草稿", "gray"],
  };
  const [label, color] = map[status];
  return (
    <span className={"status " + color}>
      {status === "grading" ? (
        <LoaderCircle size={12} className="spin" />
      ) : (
        <span />
      )}
      {label}
    </span>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <BookOpen size={26} />
      </span>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function AILabel({ children = "演示生成" }: { children?: ReactNode }) {
  return (
    <span className="ai-label">
      <Sparkles size={12} />
      {children}
    </span>
  );
}
export function BusyLabel({
  children,
  busy,
}: {
  children: ReactNode;
  busy?: boolean;
}) {
  return (
    <>
      {busy ? (
        <LoaderCircle size={15} className="spin" />
      ) : (
        <Sparkles size={15} />
      )}
      <span>{busy ? "正在整理…" : children}</span>
    </>
  );
}
export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    const el = ref.current!;
    el.showModal();
    const cancel = (e: Event) => {
      e.preventDefault();
      closeRef.current();
    };
    el.addEventListener("cancel", cancel);
    return () => {
      el.removeEventListener("cancel", cancel);
      el.close();
      prior?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={"modal " + (wide ? "wide" : "")}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
      aria-label={title}
    >
      <header>
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button className="icon-button" onClick={onClose} aria-label="关闭弹窗">
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="heading-actions">{action}</div>}
    </div>
  );
}
export function SectionHeading({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <h2>
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </h2>
      {action}
    </div>
  );
}
export function PrivacyNote({ teacher = false }: { teacher?: boolean }) {
  return (
    <div className="privacy-note">
      <LockKeyhole size={12} />
      {teacher ? "个人备课对话仅自己可见" : "你的个人对话仅自己可见"}
    </div>
  );
}
export function MiniArt({ variant = "network" }: { variant?: string }) {
  return (
    <svg
      className="course-art"
      viewBox="0 0 130 84"
      fill="none"
      aria-hidden="true"
    >
      {variant === "network" ? (
        <>
          <path
            d="M28 42h34m0 0 35-23M62 42l35 25"
            stroke="currentColor"
            opacity=".4"
            strokeWidth="1.5"
          />
          <rect
            x="10"
            y="26"
            width="31"
            height="31"
            rx="8"
            fill="currentColor"
            opacity=".1"
          />
          <rect
            x="49"
            y="29"
            width="26"
            height="26"
            rx="7"
            fill="currentColor"
            opacity=".2"
          />
          <rect
            x="91"
            y="6"
            width="26"
            height="26"
            rx="7"
            fill="currentColor"
            opacity=".1"
          />
          <rect
            x="91"
            y="54"
            width="26"
            height="26"
            rx="7"
            fill="currentColor"
            opacity=".1"
          />
          <circle cx="62" cy="42" r="4" fill="currentColor" />
          <circle cx="104" cy="19" r="3" fill="currentColor" />
          <circle cx="104" cy="67" r="3" fill="currentColor" />
          <circle cx="25" cy="42" r="3" fill="currentColor" />
        </>
      ) : variant === "os" ? (
        <>
          <rect
            x="31"
            y="17"
            width="58"
            height="48"
            rx="8"
            stroke="currentColor"
            opacity=".5"
          />
          <rect
            x="40"
            y="26"
            width="40"
            height="30"
            rx="4"
            fill="currentColor"
            opacity=".16"
          />
          {[0, 1, 2, 3].map((i) => (
            <g key={i} stroke="currentColor" opacity=".4">
              <path
                d={`M${41 + i * 12} 10v7m0 48v7M24 ${27 + i * 10}h7m58 0h7`}
              />
            </g>
          ))}
          <path
            d="m53 36-5 5 5 5m14-10 5 5-5 5"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </>
      ) : (
        <>
          <ellipse
            cx="64"
            cy="22"
            rx="29"
            ry="10"
            fill="currentColor"
            opacity=".2"
          />
          <path
            d="M35 22v37c0 13 58 13 58 0V22M35 40c0 13 58 13 58 0M35 56c0 13 58 13 58 0"
            stroke="currentColor"
            opacity=".5"
          />
          <ellipse
            cx="64"
            cy="22"
            rx="29"
            ry="10"
            stroke="currentColor"
            opacity=".5"
          />
        </>
      )}
    </svg>
  );
}
export function Diagram({
  type,
  onReference,
}: {
  type: string;
  onReference?: () => void;
}) {
  return (
    <figure className="diagram">
      <svg
        viewBox="0 0 590 275"
        role="img"
        aria-label={
          type === "handshake"
            ? "TCP 三次握手示意图，客户端与服务器依次交换 SYN、SYN ACK、ACK"
            : type === "queue"
              ? "生产者消费者缓冲区示意图"
              : "B+ 树索引示意图"
        }
      >
        <defs>
          <marker
            id={"arrow-" + type}
            markerWidth="7"
            markerHeight="7"
            refX="6"
            refY="3"
            orient="auto"
          >
            <path
              d="M0 0 6 3 0 6"
              fill="none"
              stroke="#63877b"
              strokeWidth="1.5"
            />
          </marker>
        </defs>
        {type === "handshake" ? (
          <>
            <rect x="74" y="14" width="118" height="37" rx="9" fill="#e3eee7" />
            <rect
              x="395"
              y="14"
              width="118"
              height="37"
              rx="9"
              fill="#f3e9d8"
            />
            <text x="133" y="38">
              客户端
            </text>
            <text x="454" y="38">
              服务器
            </text>
            <path
              d="M133 64v192M454 64v192"
              stroke="#bacbc3"
              strokeDasharray="4 6"
            />
            {[
              ["SYN · seq = x", 133, 84, 454, 117],
              ["SYN + ACK · seq = y, ack = x + 1", 454, 140, 133, 173],
              ["ACK · seq = x + 1, ack = y + 1", 133, 196, 454, 229],
            ].map(([label, x1, y1, x2, y2], i) => (
              <g key={i}>
                <path
                  d={`M${x1} ${y1} ${x2} ${y2}`}
                  stroke="#63877b"
                  strokeWidth="1.5"
                  markerEnd={"url(#arrow-" + type + ")"}
                />
                <text x="293" y={Number(y1) - 10} className="diagram-label">
                  {label}
                </text>
                <circle
                  cx={i === 1 ? 475 : 112}
                  cy={Number(y1)}
                  r="10"
                  fill="#e3eee7"
                />
                <text
                  x={i === 1 ? 475 : 112}
                  y={Number(y1) + 4}
                  className="diagram-number"
                >
                  {i + 1}
                </text>
              </g>
            ))}
          </>
        ) : type === "queue" ? (
          <>
            <text x="70" y="130">
              生产者
            </text>
            <text x="520" y="130">
              消费者
            </text>
            <path
              d="M114 144h47m255 0h48"
              stroke="#63877b"
              markerEnd={"url(#arrow-" + type + ")"}
            />
            {[0, 1, 2, 3, 4].map((i) => (
              <g key={i}>
                <rect
                  x={166 + i * 48}
                  y="112"
                  width="40"
                  height="58"
                  rx="7"
                  fill={i < 3 ? "#deebe4" : "#fff"}
                  stroke="#b8cec2"
                />
                <text x={186 + i * 48} y="146">
                  {i < 3 ? "01" : "—"}
                </text>
              </g>
            ))}
            <text x="290" y="210" className="diagram-label">
              mutex 保护临界区 · empty / full 协调读写
            </text>
          </>
        ) : (
          <>
            <path
              d="M295 65 151 122m144-57 144 57M151 156 93 212m58-56 57 56m231-56-57 56m57-56 57 56"
              stroke="#bacbc3"
            />
            {[
              [245, 30, "30 | 60"],
              [101, 122, "10 | 20"],
              [389, 122, "70 | 90"],
              [43, 212, "10 · 15"],
              [158, 212, "20 · 25"],
              [332, 212, "70 · 80"],
              [446, 212, "90 · 95"],
            ].map(([x, y, t]) => (
              <g key={t}>
                <rect
                  x={x}
                  y={y}
                  width="99"
                  height="36"
                  rx="7"
                  fill="#eee7f3"
                />
                <text x={Number(x) + 49} y={Number(y) + 23}>
                  {t}
                </text>
              </g>
            ))}
          </>
        )}
      </svg>
      {onReference && (
        <button className="diagram-ask" onClick={onReference}>
          <Sparkles size={13} /> 把这张图带入对话 <ChevronRight size={13} />
        </button>
      )}
    </figure>
  );
}
export function BlobPreview({
  blobId,
  name,
}: {
  blobId: string;
  name: string;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setUrl("");
    setError("");
    getBlob(blobId)
      .then((blob) => {
        if (!blob) throw new Error("浏览器中已找不到该文件，请重新上传。");
        objectUrl = URL.createObjectURL(blob);
        if (active) setUrl(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [blobId]);
  if (error) return <Empty title="文件暂时无法打开" description={error} />;
  if (!url)
    return (
      <div className="loading">
        <LoaderCircle size={20} className="spin" /> 正在读取文件…
      </div>
    );
  const ext = name.split(".").pop()?.toLowerCase();
  return (
    <div className="blob-preview">
      {["png", "jpg", "jpeg"].includes(ext || "") ? (
        <img src={url} alt={name} />
      ) : ext === "pdf" ? (
        <iframe src={url} title={name} />
      ) : (
        <Empty
          title="文件已保存在此浏览器"
          description="Office 文档的在线预览需要接入后端转换服务。你可以下载原文件查看。"
          action={
            <a className="button secondary" href={url} download={name}>
              <FileText size={15} />
              下载原文件
            </a>
          }
        />
      )}
    </div>
  );
}
export async function downloadBlob(blobId: string, name: string) {
  const blob = await getBlob(blobId);
  if (!blob) throw new Error("找不到原文件，请重新上传。");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function CheckLine({ children }: { children: ReactNode }) {
  return (
    <span className="check-line">
      <Check size={14} />
      {children}
    </span>
  );
}
export function StackedIcon() {
  return <Layers size={18} />;
}

export function formatFileSize(bytes: number) {
  return bytes < 1024
    ? bytes + " B"
    : bytes < 1024 * 1024
      ? (bytes / 1024).toFixed(1) + " KB"
      : (bytes / 1024 / 1024).toFixed(1) + " MB";
}
