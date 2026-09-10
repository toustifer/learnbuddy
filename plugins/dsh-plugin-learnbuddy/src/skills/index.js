/**
 * LearnBuddy DSH Skills 注册定义
 * 
 * 注册两个核心能力：
 * 1. learnbuddy-companion: 面向课件材料的图文解析与伴学辅导
 * 2. learnbuddy-autograder: 面向实验报告评分表规则的逐项证据核对与评语生成
 */

export function registerLearnBuddySkills(ctx) {
  if (!ctx.skills || typeof ctx.skills.registerProvider !== "function") return;

  const companionSkillContent = `---
name: learnbuddy-companion
description: LearnBuddy 交互式课件伴学与答疑技能。根据教师上传的实验指导书或课件，为学生提供循序渐进的引导式答疑。
---

# LearnBuddy 课件伴学与多模态答疑规范

## 1. 多模态图表原生溯源纪律
- 当回答涉及协议交互时序、报文首部格式、网络拓扑或 Wireshark 抓包截图时，必须严格使用句式：“根据第 X 页图表 [图表标题]...”，指明证据来源，严禁虚构图表信息。
- 当学生输入包含“> [引用第 X 页图表: ...]”或“> [引用第 X 页段落: ...]”证据引用块时，必须优先解读所引用的具体图表、关键标志位（如 SYN/ACK/RST）、seq/ack 序号演变或状态机迁移。

## 2. 教师预制答疑卡权威先验约束
- 系统已将授课教师预制的高置信度答疑卡（QA对）注入上下文。
- 当学生提问命中教师答疑范围时，必须在回答中明确标注：“根据教师推荐答疑：...”，并优先遵循教师的标准解析口径与实验排错指南。

## 3. 苏格拉底式启发教学
- 优先引导学生自主思考，采用循序渐进的追问与现象比对，切忌直接简单报答案或代写作业代码。
- 若学生遇到抓包异常（如红色 RST、超时未确认、连接被拒绝），引导学生对照过滤语法（如 tcp.port / tcp.flags）与报文交互状态展开排查。

## 4. 严守事实防幻觉
- 所有解释与指导必须立足于注入的课件正文、图表描述与实验知识点，未在资料中确认的事实保持审慎并提示验证方式。
`;

  const autograderSkillContent = `---
name: learnbuddy-autograder
description: LearnBuddy 实验报告自动核查与多模态评分技能。对照评分准则（Rubric）逐项验证图文证据。
---

# AutoGrader 评阅规范
1. 逐项核对评分表各采分点，不能遗漏实验结果截图核验；
2. 给出建设性评语，指出具体失分点在报告中的位置；
3. 严格坚守评阅反馈职责，绝不提供代写实验报告服务。
`;

  const provider = {
    name: "learnbuddy-bundled-skills",
    list: async () => [
      {
        name: "learnbuddy-companion",
        description: "交互式课件伴学与多模态答疑辅导",
        invocation: { modelInvocable: true, userInvocable: true },
        provider: "learnbuddy-bundled-skills",
        source: "bundled"
      },
      {
        name: "learnbuddy-autograder",
        description: "实验报告图文逐项核查与评分生成",
        invocation: { modelInvocable: true, userInvocable: true },
        provider: "learnbuddy-bundled-skills",
        source: "bundled"
      }
    ],
    get: async (candidate) => {
      if (candidate.name === "learnbuddy-companion") {
        return {
          name: "learnbuddy-companion",
          description: "交互式课件伴学与多模态答疑辅导",
          content: companionSkillContent
        };
      }
      return {
        name: "learnbuddy-autograder",
        description: "实验报告图文逐项核查与评分生成",
        content: autograderSkillContent
      };
    }
  };

  ctx.skills.registerProvider(() => provider);
}
