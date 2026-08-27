/* ===========================================================================
 *  示例词库 —— 仅用于跑通程序流程，切勿据此复习
 * ---------------------------------------------------------------------------
 *  ⚠ 重要说明
 *
 *  本文件中的 tag / count / cites（即「★ 真题 N 次」标注及其出处）
 *  全部是【演示用的假数据】，不是真实的历年真题统计结果。
 *
 *  它们存在的唯一目的，是让界面的分级展示、折叠、出处弹层等逻辑
 *  有东西可渲染、可测试。
 *
 *  真实的义项标注需要基于历年英语一真题语料逐句统计后生成，
 *  届时会替换掉本文件。在那之前，wordbook.demo = true 会让主程序
 *  在页面顶部常驻一条警示横幅。
 *
 *  词条本身（拼写、音标、中文释义）是准确的，可以正常用来测试背诵流程。
 * =========================================================================== */

window.WORDBOOK = {
  name:   "示例词库（考研英语一 · 演示用）",
  corpus: "示例数据 · 非真实真题统计",
  demo:   true,          // 主程序据此显示警示横幅

  words: [

    /* ---------- 一、多义词：三档齐全 + 短语 + 词根 ---------- */

    {
      word: "row",
      phonetic: "/raʊ/ (争吵) · /rəʊ/ (排;划船)",
      defs: [
        { text: "n./v. 争吵，吵闹", tag: "high", count: 4, cites: [
            { src: "示例·2013英一 Text1", sent: "The row over the new policy has intensified in recent weeks." },
            { src: "示例·2019英一 Text3", sent: "A public row broke out between the two agencies." }
        ]},
        { text: "n. 一排，一行", tag: "mid", count: 2, cites: [
            { src: "示例·2011英一 Text2", sent: "They sat in the front row of the auditorium." }
        ]},
        { text: "v. 划船", tag: "rare", count: 0, cites: [] }
      ],
      phrases: [
        { text: "in a row", zh: "连续地，接连地", count: 3, cites: [
            { src: "示例·2016英一 Text4", sent: "Profits fell for the third quarter in a row." }
        ]}
      ],
      roots: "同形异音词：/raʊ/ 与 /rəʊ/ 意义完全无关，需按读音分记",
      related: ["rowdy a. 吵闹的"]
    },

    {
      word: "address",
      phonetic: "/ə'dres/",
      defs: [
        { text: "vt. 处理，应对（问题）", tag: "high", count: 7, cites: [
            { src: "示例·2018英一 Text2", sent: "The report fails to address the root causes of inequality." },
            { src: "示例·2021英一 翻译", sent: "Policymakers must address these concerns directly." }
        ]},
        { text: "vt./n. 演讲，致辞", tag: "mid", count: 3, cites: [
            { src: "示例·2014英一 Text1", sent: "She addressed the conference on climate policy." }
        ]},
        { text: "n. 地址", tag: "rare", count: 0, cites: [] }
      ],
      phrases: [
        { text: "address oneself to", zh: "着手处理", count: 1, cites: [] }
      ],
      roots: "ad-(朝向) + dress(引导) → 把话/精力引向某处",
      related: ["addressee n. 收信人"]
    },

    {
      word: "subject",
      phonetic: "/'sʌbdʒɪkt/ (n./a.) · /səb'dʒekt/ (v.)",
      defs: [
        { text: "a. 易受…影响的；须服从…的（subject to）", tag: "high", count: 6, cites: [
            { src: "示例·2017英一 Text3", sent: "All findings are subject to peer review before publication." },
            { src: "示例·2020英一 完形", sent: "Prices are subject to change without notice." }
        ]},
        { text: "vt. 使遭受，使经历", tag: "high", count: 4, cites: [
            { src: "示例·2015英一 Text4", sent: "Participants were subjected to a series of stress tests." }
        ]},
        { text: "n. 主题，题目；学科", tag: "mid", count: 3, cites: [] },
        { text: "n. 臣民；（语法）主语", tag: "rare", count: 0, cites: [] }
      ],
      phrases: [
        { text: "be subject to", zh: "易受…影响；须经…", count: 6, cites: [
            { src: "示例·2017英一 Text3", sent: "All findings are subject to peer review." }
        ]},
        { text: "subject matter", zh: "主题内容", count: 1, cites: [] }
      ],
      roots: "sub-(在下) + ject(投掷) → 置于其下 → 服从/使遭受",
      related: ["subjective a. 主观的", "objective a. 客观的"]
    },

    {
      word: "compromise",
      phonetic: "/'kɒmprəmaɪz/",
      defs: [
        { text: "vt. 损害，危及（安全、质量、原则）", tag: "high", count: 5, cites: [
            { src: "示例·2019英一 Text2", sent: "Cutting corners here would compromise passenger safety." },
            { src: "示例·2022英一 Text1", sent: "The breach compromised millions of user accounts." }
        ]},
        { text: "n./v. 妥协，折中", tag: "mid", count: 3, cites: [
            { src: "示例·2012英一 Text3", sent: "Both sides finally reached a compromise." }
        ]}
      ],
      roots: "com-(共同) + promise(承诺) → 互相让步",
      related: ["uncompromising a. 不妥协的"]
    },

    {
      word: "appreciate",
      phonetic: "/ə'priːʃieɪt/",
      defs: [
        { text: "vt. 意识到，理解（= realize）", tag: "high", count: 5, cites: [
            { src: "示例·2016英一 Text2", sent: "Few appreciate how fragile the ecosystem really is." }
        ]},
        { text: "vt. 欣赏；感激", tag: "mid", count: 2, cites: [] },
        { text: "vi. 增值，升值", tag: "rare", count: 1, cites: [
            { src: "示例·2010英一 Text1", sent: "The currency appreciated sharply against the dollar." }
        ]}
      ],
      roots: "ap-(加强) + preci(价值) + -ate → 评定价值 → 领会/欣赏/升值",
      related: ["depreciate v. 贬值", "appreciation n. 理解；欣赏；升值"]
    },

    {
      word: "practice",
      phonetic: "/'præktɪs/",
      defs: [
        { text: "n. 惯例，常规做法", tag: "high", count: 6, cites: [
            { src: "示例·2018英一 Text1", sent: "The practice of hiring unpaid interns is now under scrutiny." }
        ]},
        { text: "n. （医生、律师的）业务，执业", tag: "mid", count: 2, cites: [
            { src: "示例·2013英一 Text4", sent: "She left her law practice to join a nonprofit." }
        ]},
        { text: "n./v. 练习，实践", tag: "mid", count: 2, cites: [] }
      ],
      phrases: [
        { text: "in practice", zh: "实际上，在实践中", count: 4, cites: [] },
        { text: "put into practice", zh: "付诸实践", count: 2, cites: [] }
      ],
      related: ["practitioner n. 从业者", "practical a. 实际的"]
    },

    {
      word: "observe",
      phonetic: "/əb'zɜːv/",
      defs: [
        { text: "vt. 遵守（法律、规则、习俗）", tag: "high", count: 4, cites: [
            { src: "示例·2015英一 Text1", sent: "Firms are required to observe strict disclosure rules." }
        ]},
        { text: "vt. 评论，说（= remark）", tag: "high", count: 3, cites: [
            { src: "示例·2020英一 Text3", sent: "\"Progress has been uneven,\" the author observes." }
        ]},
        { text: "vt. 观察，注意到", tag: "mid", count: 3, cites: [] }
      ],
      roots: "ob-(朝向) + serve(保持) → 持续注视 → 观察/遵守",
      related: ["observance n. 遵守", "observation n. 观察；评论"]
    },

    {
      word: "account",
      phonetic: "/ə'kaʊnt/",
      defs: [
        { text: "n. 描述，叙述，说明", tag: "high", count: 5, cites: [
            { src: "示例·2014英一 Text3", sent: "His account of the events differs from official records." }
        ]},
        { text: "n. 账户，账目", tag: "mid", count: 2, cites: [] }
      ],
      phrases: [
        { text: "account for", zh: "①占（比例）②解释，说明原因", count: 8, cites: [
            { src: "示例·2019英一 Text1", sent: "Renewables now account for a third of total output." },
            { src: "示例·2021英一 Text2", sent: "Genetics alone cannot account for the difference." }
        ]},
        { text: "take into account", zh: "考虑到", count: 4, cites: [] },
        { text: "on account of", zh: "由于", count: 2, cites: [] }
      ],
      roots: "ac-(加强) + count(计算) → 算清楚 → 账目/交代说明",
      related: ["accountable a. 应负责的", "accountability n. 问责"]
    },

    {
      word: "figure",
      phonetic: "/'fɪɡə/",
      defs: [
        { text: "n. 数字，数据", tag: "high", count: 6, cites: [
            { src: "示例·2017英一 Text1", sent: "The official figures understate the true jobless rate." }
        ]},
        { text: "n. 人物，名人", tag: "high", count: 4, cites: [
            { src: "示例·2016英一 Text3", sent: "He became a leading figure in the reform movement." }
        ]},
        { text: "v. 认为，判断（figure that）", tag: "mid", count: 2, cites: [] },
        { text: "n. 体形，身材；图形", tag: "rare", count: 0, cites: [] }
      ],
      phrases: [
        { text: "figure out", zh: "弄明白，想出", count: 3, cites: [] }
      ],
      related: ["figurative a. 比喻的"]
    },

    {
      word: "capital",
      phonetic: "/'kæpɪtl/",
      defs: [
        { text: "n. 资本，资金", tag: "high", count: 5, cites: [
            { src: "示例·2018英一 Text4", sent: "Venture capital flowed into the sector after 2015." }
        ]},
        { text: "n. 首都；a. 大写的", tag: "mid", count: 2, cites: [] },
        { text: "a. 死刑的（capital punishment）", tag: "rare", count: 1, cites: [
            { src: "示例·2007英一 Text2", sent: "The debate over capital punishment resurfaced." }
        ]}
      ],
      roots: "capit-(头) → 头等的 → 首都/资本/大写",
      related: ["capitalism n. 资本主义", "capitalize v. 利用；大写"]
    },

    {
      word: "term",
      phonetic: "/tɜːm/",
      defs: [
        { text: "n. 术语，措辞", tag: "high", count: 5, cites: [
            { src: "示例·2015英一 Text2", sent: "The term \"sustainability\" is now used far too loosely." }
        ]},
        { text: "n. 条款，条件（常用复数 terms）", tag: "mid", count: 3, cites: [] },
        { text: "n. 学期；任期", tag: "mid", count: 2, cites: [] }
      ],
      phrases: [
        { text: "in terms of", zh: "就…而言，从…角度", count: 9, cites: [
            { src: "示例·2020英一 Text1", sent: "In terms of cost, the two options are comparable." }
        ]},
        { text: "come to terms with", zh: "接受，妥协于", count: 2, cites: [] },
        { text: "long-term / short-term", zh: "长期的 / 短期的", count: 6, cites: [] }
      ]
    },

    {
      word: "state",
      phonetic: "/steɪt/",
      defs: [
        { text: "vt. 陈述，声明，明确指出", tag: "high", count: 6, cites: [
            { src: "示例·2019英一 Text4", sent: "The report clearly states that the trend is reversible." }
        ]},
        { text: "n. 状态，状况", tag: "high", count: 4, cites: [] },
        { text: "n. 国家；州；a. 国家的", tag: "mid", count: 3, cites: [] }
      ],
      related: ["statement n. 陈述", "statesman n. 政治家"]
    },

    {
      word: "sound",
      phonetic: "/saʊnd/",
      defs: [
        { text: "a. 合理的，可靠的，健全的", tag: "high", count: 4, cites: [
            { src: "示例·2017英一 Text2", sent: "The argument rests on sound empirical evidence." }
        ]},
        { text: "v. 听起来；n. 声音", tag: "mid", count: 2, cites: [] }
      ],
      phrases: [
        { text: "sound out", zh: "试探（意见）", count: 0, cites: [] }
      ],
      related: ["soundly ad. 稳健地；酣畅地"]
    },

    {
      word: "hold",
      phonetic: "/həʊld/",
      defs: [
        { text: "vt. 认为，主张（hold that）", tag: "high", count: 5, cites: [
            { src: "示例·2016英一 Text1", sent: "Critics hold that the reform went too far." }
        ]},
        { text: "vt. 举行；持有；容纳", tag: "mid", count: 3, cites: [] },
        { text: "vi. 有效，适用", tag: "mid", count: 2, cites: [
            { src: "示例·2021英一 Text3", sent: "The conclusion does not hold for smaller firms." }
        ]}
      ],
      phrases: [
        { text: "hold back", zh: "阻碍；抑制", count: 2, cites: [] },
        { text: "hold on to", zh: "保持，不放弃", count: 1, cites: [] }
      ]
    },

    {
      word: "spell",
      phonetic: "/spel/",
      defs: [
        { text: "n. 一段时间（a spell of）", tag: "mid", count: 2, cites: [
            { src: "示例·2012英一 Text1", sent: "After a long spell of unemployment, he retrained." }
        ]},
        { text: "vt. 意味着（招致坏结果，spell disaster）", tag: "mid", count: 2, cites: [
            { src: "示例·2018英一 Text3", sent: "Rising rates could spell trouble for borrowers." }
        ]},
        { text: "vt. 拼写", tag: "rare", count: 0, cites: [] },
        { text: "n. 咒语", tag: "rare", count: 0, cites: [] }
      ]
    },

    {
      word: "bear",
      phonetic: "/beə/",
      defs: [
        { text: "vt. 承担，承受（责任、费用、后果）", tag: "high", count: 4, cites: [
            { src: "示例·2020英一 Text2", sent: "Consumers ultimately bear the cost of the tariffs." }
        ]},
        { text: "vt. 忍受（常用于否定句）", tag: "mid", count: 2, cites: [] },
        { text: "n. 熊", tag: "rare", count: 0, cites: [] }
      ],
      phrases: [
        { text: "bear in mind", zh: "记住，考虑到", count: 3, cites: [] },
        { text: "bear out", zh: "证实", count: 1, cites: [] }
      ]
    },

    {
      word: "issue",
      phonetic: "/'ɪʃuː/",
      defs: [
        { text: "n. 问题，议题", tag: "high", count: 9, cites: [
            { src: "示例·2019英一 Text1", sent: "Privacy has become the defining issue of the decade." }
        ]},
        { text: "vt. 发布，颁发；n. （期刊的）一期", tag: "mid", count: 3, cites: [] }
      ],
      phrases: [
        { text: "at issue", zh: "争论中的", count: 1, cites: [] },
        { text: "take issue with", zh: "对…提出异议", count: 1, cites: [] }
      ]
    },

    {
      word: "matter",
      phonetic: "/'mætə/",
      defs: [
        { text: "vi. 要紧，有影响", tag: "high", count: 5, cites: [
            { src: "示例·2017英一 Text4", sent: "What matters is not speed but direction." }
        ]},
        { text: "n. 事情，问题", tag: "mid", count: 3, cites: [] },
        { text: "n. 物质", tag: "rare", count: 1, cites: [] }
      ],
      phrases: [
        { text: "a matter of", zh: "…的问题；仅仅", count: 3, cites: [] },
        { text: "no matter how/what", zh: "无论如何/什么", count: 2, cites: [] }
      ]
    },

    {
      word: "reason",
      phonetic: "/'riːzn/",
      defs: [
        { text: "n. 理性，理智；v. 推理，论证", tag: "high", count: 4, cites: [
            { src: "示例·2015英一 翻译", sent: "Reason, rather than instinct, should guide policy." }
        ]},
        { text: "n. 原因，理由", tag: "mid", count: 4, cites: [] }
      ],
      related: ["reasoning n. 推理", "reasonable a. 合理的"]
    },

    {
      word: "discipline",
      phonetic: "/'dɪsəplɪn/",
      defs: [
        { text: "n. 学科，领域", tag: "high", count: 4, cites: [
            { src: "示例·2018英一 Text2", sent: "The problem cuts across several academic disciplines." }
        ]},
        { text: "n. 纪律；自制力", tag: "mid", count: 2, cites: [] },
        { text: "vt. 惩戒，训练", tag: "rare", count: 0, cites: [] }
      ],
      related: ["interdisciplinary a. 跨学科的"]
    },

    /* ---------- 二、单义或双义词：有标注 ---------- */

    {
      word: "advocate",
      phonetic: "/'ædvəkeɪt/ (v.) · /'ædvəkət/ (n.)",
      defs: [
        { text: "vt. 提倡，主张", tag: "high", count: 4, cites: [
            { src: "示例·2019英一 Text3", sent: "The report advocates a phased approach to reform." }
        ]},
        { text: "n. 拥护者，倡导者", tag: "mid", count: 3, cites: [] }
      ],
      roots: "ad-(朝向) + voc(声音) + -ate → 为…发声",
      related: ["vocal a. 直言的", "evoke v. 唤起", "advocacy n. 拥护"]
    },

    {
      word: "acknowledge",
      phonetic: "/ək'nɒlɪdʒ/",
      defs: [
        { text: "vt. 承认（事实、错误）", tag: "high", count: 5, cites: [
            { src: "示例·2020英一 Text4", sent: "The agency acknowledged that early warnings were ignored." }
        ]},
        { text: "vt. 致谢；答谢", tag: "rare", count: 0, cites: [] }
      ],
      related: ["acknowledgement n. 承认；致谢"]
    },

    {
      word: "accommodate",
      phonetic: "/ə'kɒmədeɪt/",
      defs: [
        { text: "vt. 容纳；为…提供空间", tag: "mid", count: 2, cites: [] },
        { text: "vt. 迁就，适应，顾及（需求）", tag: "high", count: 3, cites: [
            { src: "示例·2021英一 Text1", sent: "Schedules were redesigned to accommodate remote workers." }
        ]}
      ],
      roots: "ac- + commod(方便) + -ate → 使方便 → 容纳/迁就",
      related: ["accommodation n. 住处；适应"]
    },

    {
      word: "alleviate",
      phonetic: "/ə'liːvieɪt/",
      defs: [
        { text: "vt. 减轻，缓解（痛苦、问题）", tag: "high", count: 3, cites: [
            { src: "示例·2016英一 Text4", sent: "Cash transfers did little to alleviate rural poverty." }
        ]}
      ],
      roots: "al- + lev(轻) + -ate → 使变轻",
      related: ["elevate v. 提升", "levity n. 轻率"]
    },

    {
      word: "ambiguous",
      phonetic: "/æm'bɪɡjuəs/",
      defs: [
        { text: "a. 模棱两可的，含糊不清的", tag: "high", count: 3, cites: [
            { src: "示例·2017英一 Text3", sent: "The wording is deliberately ambiguous." }
        ]}
      ],
      roots: "ambi-(两边) + ig(驱动) → 两边都说得通",
      related: ["ambiguity n. 歧义", "ambivalent a. 矛盾的"]
    },

    {
      word: "accumulate",
      phonetic: "/ə'kjuːmjəleɪt/",
      defs: [
        { text: "v. 积累，积聚", tag: "mid", count: 2, cites: [] }
      ],
      roots: "ac- + cumul(堆) + -ate → 堆积起来",
      related: ["accumulation n. 积累", "cumulative a. 累积的"]
    },

    {
      word: "aggregate",
      phonetic: "/'æɡrɪɡət/ (n./a.) · /'æɡrɪɡeɪt/ (v.)",
      defs: [
        { text: "n./a. 总计（的），合计（的）", tag: "mid", count: 2, cites: [
            { src: "示例·2014英一 Text2", sent: "In aggregate, household debt continued to climb." }
        ]},
        { text: "vt. 聚集，汇总", tag: "rare", count: 0, cites: [] }
      ],
      roots: "ag- + greg(群) + -ate → 聚成一群",
      related: ["gregarious a. 群居的；爱社交的", "segregate v. 隔离"]
    },

    {
      word: "adequate",
      phonetic: "/'ædɪkwət/",
      defs: [
        { text: "a. 足够的，适当的", tag: "high", count: 4, cites: [
            { src: "示例·2018英一 完形", sent: "Few schools have adequate funding for the program." }
        ]}
      ],
      roots: "ad- + equ(相等) + -ate → 与需求相当",
      related: ["inadequate a. 不足的", "equate v. 等同"]
    },

    {
      word: "abundant",
      phonetic: "/ə'bʌndənt/",
      defs: [
        { text: "a. 丰富的，充裕的", tag: "mid", count: 2, cites: [] }
      ],
      related: ["abundance n. 大量", "abound v. 大量存在"]
    },

    {
      word: "accelerate",
      phonetic: "/ək'seləreɪt/",
      defs: [
        { text: "v. 加速，加快", tag: "mid", count: 3, cites: [
            { src: "示例·2021英一 Text4", sent: "The pandemic accelerated the shift to online retail." }
        ]}
      ],
      roots: "ac- + celer(快) + -ate",
      related: ["acceleration n. 加速", "decelerate v. 减速"]
    },

    {
      word: "aesthetic",
      phonetic: "/iːs'θetɪk/",
      defs: [
        { text: "a. 美学的，审美的；n. 审美观", tag: "mid", count: 2, cites: [] }
      ],
      related: ["aesthetics n. 美学"]
    },

    {
      word: "affluent",
      phonetic: "/'æfluənt/",
      defs: [
        { text: "a. 富裕的，富足的", tag: "mid", count: 2, cites: [
            { src: "示例·2013英一 Text2", sent: "Affluent households were least affected by the cuts." }
        ]}
      ],
      roots: "af- + flu(流) + -ent → 财富流入",
      related: ["fluent a. 流利的", "influx n. 涌入", "affluence n. 富裕"]
    },

    {
      word: "abolish",
      /* 故意缺 phonetic —— 用于测试字段缺失时的降级渲染 */
      defs: [
        { text: "vt. 废除，取消（制度、法律）", tag: "mid", count: 2, cites: [] }
      ],
      related: ["abolition n. 废除"]
    },

    /* ---------- 三、无任何真题标注的词（count 全为 0，界面不应出现★） ---------- */

    {
      word: "abandon",
      phonetic: "/ə'bændən/",
      defs: [
        { text: "vt. 放弃，抛弃；离弃", tag: "rare", count: 0, cites: [] },
        { text: "n. 放纵，放任", tag: "rare", count: 0, cites: [] }
      ],
      roots: "a-(朝向) + bandon(控制) → 脱离控制",
      related: ["abandonment n. 放弃"]
    },

    {
      word: "coherent",
      phonetic: "/kəʊ'hɪərənt/",
      defs: [
        { text: "a. 连贯的，条理清楚的", tag: "rare", count: 0, cites: [] }
      ],
      roots: "co-(共同) + her(粘附) + -ent → 粘在一起",
      related: ["cohesion n. 凝聚力", "adhere v. 坚持；粘附"]
    },

    {
      word: "prevalent",
      phonetic: "/'prevələnt/",
      defs: [
        { text: "a. 流行的，普遍的", tag: "rare", count: 0, cites: [] }
      ],
      related: ["prevail v. 盛行；获胜", "prevalence n. 流行程度"]
    },

    /* ---------- 四、极简词条：只有 word + defs[].text（测试最低限度降级） ---------- */

    { word: "hardly",     defs: [{ text: "ad. 几乎不，简直不" }] },
    { word: "scarcely",   defs: [{ text: "ad. 几乎不；刚刚" }] },
    { word: "nonetheless",defs: [{ text: "ad. 尽管如此，然而" }] },
    { word: "albeit",     defs: [{ text: "conj. 虽然，尽管" }] },
    { word: "notwithstanding", defs: [{ text: "prep. 尽管；ad. 但是" }] },
    { word: "hitherto",   defs: [{ text: "ad. 迄今为止，到目前为止" }] },

    /* ---------- 五、常见易混词对（测试选择题干扰项从相邻位置抽取） ---------- */

    {
      word: "adapt",
      phonetic: "/ə'dæpt/",
      defs: [
        { text: "v. 适应；改编", tag: "mid", count: 3, cites: [] }
      ],
      related: ["adopt v. 采纳（勿混）", "adaptation n. 适应；改编"]
    },
    {
      word: "adopt",
      phonetic: "/ə'dɒpt/",
      defs: [
        { text: "vt. 采纳，采取（措施）；收养", tag: "high", count: 4, cites: [
            { src: "示例·2020英一 Text1", sent: "Several states have adopted similar measures." }
        ]}
      ],
      related: ["adapt v. 适应（勿混）", "adoption n. 采用；收养"]
    },
    {
      word: "conscious",
      phonetic: "/'kɒnʃəs/",
      defs: [
        { text: "a. 意识到的；有意的", tag: "mid", count: 3, cites: [] }
      ],
      related: ["conscientious a. 认真尽责的（勿混）", "consciousness n. 意识"]
    },
    {
      word: "conscientious",
      phonetic: "/ˌkɒnʃi'enʃəs/",
      defs: [
        { text: "a. 认真的，尽责的", tag: "rare", count: 0, cites: [] }
      ],
      related: ["conscious a. 意识到的（勿混）"]
    }

  ]
};
