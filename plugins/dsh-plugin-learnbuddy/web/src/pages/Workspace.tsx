import { ArrowRight, ArrowUpRight, BookOpen, Check, ChevronRight, Clock3, Files, NotebookPen } from "lucide-react";
import { Button, Badge, Tooltip } from "@radix-ui/themes";
import { motion } from "motion/react";
import { useStore } from "../store-context";
import { visibleAssignments, visibleCourses, visibleMaterials, visibleSubmissions } from "../domain";
import { LIVE_MODE } from "../api";
import { Empty, FileIcon, PageHeading } from "../ui";
import { Library } from "./Library";
import { AcademicNotice, dateLabel, latestSubmission } from "./Academic";

export function CourseGallery() {
  const { user, state, go, materialsLoading, materialsError } = useStore();
  const courses = visibleCourses(user!);
  const materials = visibleMaterials(state, user!).filter((m) => m.visibility === "course");
  const assignments = visibleAssignments(state, user!);
  return <div className="page course-gallery">
    <PageHeading eyebrow="YOUR COURSES" title={user!.role === "teacher" ? "任教课程" : "课程学习"} description={user!.role === "teacher" ? "每门课的资料、作业和学生反馈，集中在一起。" : "选一门课，从资料阅读到作业反馈，接着学下去。"} />
    <AcademicNotice />
    <div className="gallery-label"><span>{courses.length} 门课程</span><span>课程资料 · 作业与反馈</span></div>
    <div className="course-collection">
      {courses.map((course, index) => <motion.button key={course.id} className={`course-overview-card ${course.color}`} onClick={() => go({ page: "course", id: course.id })}
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .25, delay: index * .045 }} whileHover={{ y: -3 }}>
        <div className="course-overview-card-top"><span className="course-code">{course.code}</span><ArrowUpRight size={19} /></div>
        <div className="course-overview-card-heading"><span className={`course-monogram large ${course.color}`}>{course.title.slice(0, 1)}</span><h2>{course.title}</h2></div>
        <p>{course.description}</p>
        <div className="course-overview-card-footer"><span><Files size={14} />{materialsLoading ? "读取中" : materialsError ? "资料待重试" : `${materials.filter((m) => m.courseId === course.id).length} 份资料`}</span><span><NotebookPen size={14} />{assignments.filter((a) => a.courseId === course.id).length} 项作业</span><ChevronRight size={16} /></div>
      </motion.button>)}
    </div>
    {!courses.length && <Empty title="还没有课程" description="加入课程后，资料与作业会出现在这里。" />}
  </div>;
}

export function CourseWorkspace({ id }: { id: string }) {
  const { user, state, go } = useStore();
  const course = visibleCourses(user!).find((c) => c.id === id);
  if (!course) return <div className="page"><Empty title="无法查看这门课程" action={<Button onClick={() => go({ page: "courses" })}>返回课程学习</Button>} /></div>;
  const assignments = visibleAssignments(state, user!).filter((a) => a.courseId === id);
  return <div className="page course-workspace">
    <div className="course-intro">
      <span className={`course-monogram large ${course.color}`}>{course.title.slice(0, 1)}</span>
      <div><span className="course-code">{course.code}</span><h1>{course.title}</h1><p>{course.description}</p></div>
      <Button variant="soft" size="3" onClick={() => go({ page: "assignments", courseId: id })}><NotebookPen size={16} />课程作业 <Badge color="gray" variant="soft">{assignments.length}</Badge><ArrowUpRight size={15} /></Button>
    </div>
    <Library scope={id} />
  </div>;
}

export function HomeWorkspace() {
  const { user, state, go, academicLoading, materialsLoading, materialsError } = useStore();
  const teacher = user!.role === "teacher";
  const courses = visibleCourses(user!);
  const materials = visibleMaterials(state, user!);
  const assignments = visibleAssignments(state, user!);
  const submissions = visibleSubmissions(state, user!);
  const needingReview = submissions.filter((s) => (s.status === "review" || s.status === "submitted") && latestSubmission(submissions, s.assignmentId, s.studentId)?.id === s.id);
  const pendingAssignments = assignments.filter((a) => teacher ? !a.published || needingReview.some((s) => s.assignmentId === a.id) : !latestSubmission(submissions, a.id, user!.id));
  let lastRead = "";
  try { lastRead = localStorage.getItem(`learnbuddy-recent:${LIVE_MODE}:${user!.id}`) || ""; } catch { /* Optional reading preference. */ }
  const recent = materials.find((m) => m.id === lastRead);
  const readable = recent || materials.find((m) => m.visibility === "course" && m.status === "ready");
  const date = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date());
  return <div className="page home-workspace">
    <div className="home-date">{date}<span>LEARNBUDDY WORKSPACE</span></div>
    <PageHeading title={`${user!.name}，${teacher ? "开始今天的教学" : "今天也学懂一点"}。`} description={teacher ? "备好下一节课，也给每一份努力一个回应。" : "回到正在读的材料，或看看下一项作业。"} />
    <AcademicNotice />
    <section className="home-focus">
      <div className="home-reading">
        <div className="focus-label"><BookOpen size={17} />{recent ? "继续上次阅读" : "从课程资料开始"}</div>
        {readable ? <><div className="focus-course">{courses.find((c) => c.id === readable.courseId)?.title}</div><h2>{readable.title}</h2><p>原文、知识点和学习助手，都在同一个阅读空间。</p><Button size="3" onClick={() => go({ page: "material", id: readable.id })}>{teacher ? "打开备课空间" : "继续阅读"}<ArrowRight size={17} /></Button></>
          : <><h2>{materialsLoading ? "正在读取课程资料…" : materialsError ? "资料暂时无法读取" : "一门课，一个新的开始"}</h2><p>{materialsError || "进入课程，查看讲义和学习任务。"}</p><Button onClick={() => go({ page: "courses" })}>查看课程<ArrowRight size={16} /></Button></>}
        <div className="focus-mark" aria-hidden="true"><span/><span/><span/></div>
      </div>
      <div className="home-tasks"><div className="section-heading"><h2>{teacher ? "需要关注" : "待完成作业"}</h2><Tooltip content="查看全部作业"><Button size="1" variant="ghost" color="gray" onClick={() => go({ page: "assignments" })}>全部<ArrowUpRight size={14} /></Button></Tooltip></div>
        {academicLoading && !assignments.length ? <p className="home-tasks-empty">正在读取任务…</p> : pendingAssignments.length ? pendingAssignments.slice(0, 3).map((a) => <button className="home-task-row" key={a.id} onClick={() => go({ page: teacher && a.published ? "grading" : "assignment", id: a.id })}>
          <span className="task-check"><NotebookPen size={15} /></span><span><strong>{a.title}</strong><small>{teacher ? !a.published ? "作业草稿" : `${needingReview.filter((s) => s.assignmentId === a.id).length} 份提交待处理 · ${dateLabel(a.due)} 截止` : <><Clock3 size={11} />{dateLabel(a.due)} 截止</>}</small></span><ChevronRight size={14} />
        </button>) : <div className="home-tasks-empty"><Check size={22} /><p>当前没有待处理的任务</p><span>可以留一点时间，回顾已经学过的内容。</span></div>}
      </div>
    </section>
    <section className="home-course-section"><div className="section-heading"><h2>{teacher ? "任教课程" : "我的课程"}<span className="heading-count">{courses.length}</span></h2><Button variant="ghost" color="gray" onClick={() => go({ page: "courses" })}>课程总览<ArrowRight size={15} /></Button></div>
      <div className="home-course-list">{courses.map((c) => <button key={c.id} onClick={() => go({ page: "course", id: c.id })}><span className={`course-monogram ${c.color}`}>{c.title.slice(0, 1)}</span><span><strong>{c.title}</strong><small>{c.code}</small></span><ArrowUpRight size={17} /></button>)}</div>
    </section>
    {recent && <div className="home-recent-note"><FileIcon kind={recent.kind} /><span>最近阅读记录仅保存在这台设备上。</span></div>}
  </div>;
}
