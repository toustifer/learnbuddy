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

# LearnBuddy 课件伴学规范
1. 当学生询问实验原理或步骤时，优先比对课程知识点；
2. 引导学生自主思考，采用苏格拉底式追问而非直接报答案；
3. 如果学生提到了具体的报错（如 RST、超时、握手失败），给出针对性抓包过滤排查建议。
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
