import type { AgentDecision, PolicyAssessment, RiskLevel } from "../types.js";
import {
  detectSupportedClientLocale,
  type SupportedClientLocale,
} from "./locale.js";

export const POLICY_VERSION = "hera-whatsapp-policy-1.3.0";

const RISK_RANK: Record<RiskLevel, number> = {
  green: 0,
  amber: 1,
  red: 2,
  black: 3,
};

const BLACK_PATTERNS = [
  /(?:i\s*(?:can'?t|cannot)|unable to)\s*breathe/i,
  /difficulty breathing|trouble breathing|throat (?:is )?closing/i,
  /severe (?:facial )?swelling|face (?:is )?swelling/i,
  /unconscious|collapsed|anaphylaxis/i,
  /severe (?:chemical )?burn|blistering|chemical (?:in|near) (?:my )?eyes?/i,
  /threat(?:en|ening)? (?:to )?(?:hurt|kill)|physical violence/i,
  /(?:不能|无法|没法)呼吸|呼吸困难|喘不过气|喉咙(?:正在)?(?:收紧|闭合)|面部严重肿胀|脸(?:部)?肿(?:了|胀)|昏倒|失去意识|严重(?:化学)?灼伤|起泡|化学品(?:进入|溅入)(?:我)?(?:的)?眼睛/u,
  /susah bernafas|tidak boleh bernafas|tak boleh bernafas|tekak (?:sedang )?(?:tertutup|menyempit)|muka (?:sangat )?bengkak|pengsan|melecur teruk|lepuh|bahan kimia (?:masuk|terkena) mata/i,
  /மூச்சு விட முடியவில்லை|சுவாசிக்க முடியவில்லை|மூச்சுத் திணறல்|முகம் வீக்கம்|தொண்டை வீக்கம்|மயங்கி|கடுமையான தீக்காயம்|கொப்புளம்|கண்ணில் இரசாயனம்/u,
];

const OPT_OUT_PATTERNS = [
  /\b(?:stop|quit)\s+(?:sending|messaging|contacting|texting)\s+me\b/i,
  /\b(?:unsubscribe|opt[ -]?out|remove my (?:phone )?number|take me off (?:your|the)(?: message)? list|no more (?:messages|texts|reminders))\b/i,
  /\b(?:do not|don'?t)\s+(?:send|message|contact|text)\s+me\b/i,
  /\b(?:do not|don'?t)\s+send\s+me\s+(?:any more\s+)?(?:messages|texts|reminders)\b/i,
  /不要再(?:发|发送)?(?:消息|信息|提醒)|停止(?:发|发送)?(?:消息|信息|提醒)|取消订阅|把我从(?:你们的|您的|你们)?名单(?:中)?移除|删除我的(?:电话)?号码/u,
  /berhenti (?:hantar|menghantar) (?:mesej|peringatan)|jangan (?:hantar|menghantar) (?:mesej|peringatan)(?: lagi)?|nyahlanggan|buang nombor saya|keluarkan saya dari senarai/i,
  /(?:எனக்கு )?இனி செய்தி அனுப்பாதீர்கள்|செய்தி அனுப்புவதை நிறுத்துங்கள்|சந்தாவை நிறுத்துங்கள்|என் எண்ணை நீக்குங்கள்|பட்டியலிலிருந்து என்னை நீக்குங்கள்/u,
];

const RED_PATTERNS = [
  ...OPT_OUT_PATTERNS,
  /lawyer|legal action|sue|court|police report|cctv|evidence request/i,
  /chargeback|compensation|refund|money back/i,
  /allergic|allergy|burn(?:ed|t)?|scalp (?:pain|wound|injury)|hair (?:loss|is falling out|falling out)/i,
  /pregnan(?:t|cy)|breastfeeding|chemotherapy|\bchemo\b|alopecia|psoriasis|eczema|scalp condition/i,
  /damage(?:d)? my hair|chemical injury/i,
  /harass(?:ed|ment)|discriminat(?:ed|ion)|threaten(?:ed|ing)/i,
  /delete my data|privacy complaint|personal data|pdpa/i,
  /personal (?:phone|mobile|contact|number)|private (?:phone|mobile) number/i,
  /posted (?:my|the) (?:photo|picture).{0,40}(?:without|didn'?t|did not).{0,24}(?:ask|consent|permission)|without my (?:consent|permission)/i,
  /(?:someone else|another (?:client|customer)|my friend).{0,40}(?:appointment|booking|records?|personal data)/i,
  /律师|法律行动|起诉|法庭|报警|警方报告|监控录像|证据|退款|赔偿|过敏|灼伤|头皮(?:疼|痛|受伤)|脱发|头发受损|删除(?:我)?(?:的)?数据|隐私投诉|个人资料/u,
  /peguam|tindakan undang-undang|saman|mahkamah|laporan polis|rakaman cctv|bayaran balik|pampasan|alahan|alergi|melecur|kulit kepala (?:sakit|cedera)|rambut gugur|rambut rosak|padam data|aduan privasi|data peribadi/i,
  /வழக்கறிஞர்|சட்ட நடவடிக்கை|நீதிமன்றம்|காவல் துறை|பணத்தைத் திருப்பி|இழப்பீடு|ஒவ்வாமை|தீக்காயம்|உச்சந்தலை வலி|முடி உதிர்வு|தனிப்பட்ட தரவு|தனியுரிமை/u,
];

const AMBER_PATTERNS = [
  /complaint|unhappy|upset|disappointed|dissatisfied/i,
  /too (?:short|dark|light|warm|cool)|brassy|uneven|patchy/i,
  /overcharg(?:ed|ing)|price dispute|unexpected (?:charge|price)/i,
  /rude|unprofessional|waited|running late|late for my appointment/i,
  /redo|re-do|fix my hair|service concern|not what i (?:asked|wanted)/i,
  /strand test (?:has )?(?:failed|did not pass)|failed (?:the )?strand test/i,
  /\b(?:henna|box dye|home colo(?:u)?r|colour-restoring shampoo|color-restoring shampoo|herbal colo(?:u)?r)\b/i,
  /\b(?:patch test|black henna tattoo|skip (?:the )?(?:patch|strand) test)\b/i,
  /\b(?:rebond(?:ed|ing)|relaxed|permed?|keratin).{0,50}(?:bleach|colo(?:u)?r|highlights?|same day|weeks? ago)\b/i,
  /\b(?:bleach|colo(?:u)?r|highlights?).{0,50}(?:rebond(?:ed|ing)|relaxed|permed?|keratin)\b/i,
  /\b(?:running|stuck in traffic).{0,24}(?:late|mins?|minutes?)\b|\b(?:1[0-9]|[2-9][0-9])\s*(?:mins?|minutes?)\s+late\b/i,
  /\b(?:charged twice|duplicate charge|tax invoice|invoice dispute)\b/i,
  /\b(?:deposit dispute|no[ -]?show charge|charged for (?:a )?no[ -]?show|cancelled.{0,30}(?:deposit|charge))\b/i,
  /\b(?:colour correction|color correction|hair went green|band of orange|fix (?:this|my hair))\b/i,
  /\b(?:colour|color|bleach|highlights?)\b.{0,36}\b(?:child|minor|1[0-7][ -]?year[ -]?old)\b|\b(?:child|minor|1[0-7][ -]?year[ -]?old)\b.{0,36}\b(?:colour|color|bleach|highlights?)\b/i,
  /\b(?:this is a joke|answer me|unacceptable|destroyed my hair)\b/i,
  /\b(?:another salon|second opinion|match their price|competitor)\b/i,
  /投诉|不满意|不开心|失望|颜色不均|色泽不均|斑驳|等了很久|迟到|粗鲁|不专业|重做|修复我的头发|发束测试失败/u,
  /aduan|tidak puas hati|tak puas hati|kecewa|warna tidak sekata|bertompok|menunggu terlalu lama|lambat|kasar|tidak profesional|buat semula|baiki rambut|ujian helai (?:gagal|tidak lulus)/i,
  /புகார்|திருப்தி இல்லை|ஏமாற்றம்|நிறம் சீராக இல்லை|நீண்ட நேரம் காத்திருந்தேன்|தாமதம்|முரட்டுத்தனம்|தொழில்முறை இல்லை|மீண்டும் செய்ய|முடியை சரிசெய்ய/u,
];

const INJECTION_PATTERNS = [
  /ignore (?:all |the )?(?:previous|prior|system) instructions/i,
  /reveal (?:the )?(?:system prompt|hidden instructions|knowledge base)/i,
  /developer message|jailbreak|bypass (?:the )?(?:rules|policy|safety)/i,
  /act as if you (?:have|had) no restrictions/i,
  /忽略(?:之前|先前|系统)(?:的)?(?:所有)?指示|显示(?:系统提示|隐藏指示)|绕过(?:规则|政策|安全)/u,
  /abaikan (?:semua )?arahan (?:sebelum|sistem)|dedahkan (?:prompt|arahan) sistem|pintas (?:peraturan|dasar|keselamatan)/i,
];

const UNAUTHORISED_ACTION_PATTERNS = [
  /(?:i|we)(?:'ve| have) (?:booked|cancelled|rescheduled) (?:your|the) appointment/i,
  /(?:i|we) will (?:refund|compensate|reimburse)/i,
  /(?:your )?refund (?:is|has been) (?:approved|processed)/i,
  /(?:i have|i've|we have|we've) applied (?:the |a )?(?:10% )?discount/i,
  /(?:the |your )?(?:10% )?discount (?:is|has been) applied/i,
  /guarantee(?:d)? (?:result|outcome|damage-free|safe)/i,
  /(?:this is|you have) (?:an allergy|a chemical burn|alopecia|eczema|psoriasis)/i,
  /(?:我|我们)?(?:已|已经)(?:为你|为您)?(?:预订|取消|改期|重新安排|更改)(?:了|好)?(?:你的|您的)?预约/u,
  /(?:我|我们)(?:会|将)(?:退款|赔偿)|退款(?:已|已经)(?:批准|处理)/u,
  /(?:我|我们)?(?:已|已经)(?:应用|加入|提供)(?:了)?(?:10%|百分之十)?折扣/u,
  /(?:saya|kami) telah (?:menempah|membatalkan|menjadualkan semula|mengubah) (?:janji temu|tempahan)/i,
  /(?:saya|kami) akan (?:membayar balik|memberi pampasan)|bayaran balik (?:telah )?(?:diluluskan|diproses)/i,
  /(?:saya|kami) telah (?:menggunakan|memberikan) diskaun/i,
  /(?:நான்|நாங்கள்).{0,20}(?:முன்பதிவு செய்துவிட்டேன்|ரத்து செய்துவிட்டேன்|மாற்றிவிட்டேன்|மறுதிட்டமிட்டேன்)/u,
  /(?:பணத்தைத் திருப்பித் தருவேன்|இழப்பீடு வழங்குவேன்|பணத்தைத் திருப்புதல் (?:அங்கீகரிக்கப்பட்டது|செயலாக்கப்பட்டது))/u,
];

export const URGENT_SAFETY_REPLY =
  "This may be an emergency. Please call Singapore emergency services on 995 now, or have someone take you to the nearest emergency department immediately. Stop using the product and do not wait for the salon to respond before seeking urgent medical help; Hera’s team will follow up separately once you are safe. This is not a medical diagnosis.";

export const SAFE_CONCERN_REPLY =
  "I’m sorry to hear this. I’ve opened a priority service concern so the facts can be reviewed carefully. Please share the appointment name and date, stylist if known, what happened, and clear photos where relevant. I won’t make assumptions or promise a remedy before the details are reviewed, but I’ll keep the case organised here.";

export const SAFE_MEDICAL_CONCERN_REPLY =
  "I’m sorry you’re experiencing this. Please stop using the product or pause the service. If pain, burning, swelling, rash, eye irritation or other symptoms are significant or worsening, seek prompt medical attention. I’ve opened a priority Hera concern; when safe, please share the appointment name and date, what was used if known, and clear photos. This is not a medical diagnosis.";

export const SAFE_PRIVACY_LEGAL_REPLY =
  "I’ve recorded your privacy or legal request as a priority case. To protect personal data, identity and scope must be verified before any access, correction, deletion, CCTV or evidence action. Please provide the appointment name and date and state the exact records or action requested; I won’t expose information or promise an outcome before verification.";

export const SAFE_OPT_OUT_REPLY =
  "I understand. I’ve recorded this as a priority request to stop WhatsApp messages. Hera must apply the suppression across the relevant messaging systems before it is treated as complete; I won’t claim that has happened until it is confirmed. You do not need to repeat the request.";

export const SAFE_WAIT_RECOVERY_REPLY =
  "You’re right to flag a wait beyond 10 minutes. Hera’s stated service-recovery policy is a 10% discount. I’ve recorded the concern, but I cannot claim the bill has been updated until the transaction is confirmed.";

export const SAFE_STRAND_TEST_REPLY =
  "A failed strand test means bleach should not proceed. Hair and client safety take priority over the requested colour result; the safer next step is a stylist-led alternative plan that does not override the failed test.";

export const SAFE_BOOKING_REPLY =
  "I can help you choose the right service and check any appointment details already recorded, but I cannot claim a booking change until the booking system confirms it. Please use Hera’s secure booking page: https://bookings.gettimely.com/herabeauty1/bb/book, or tell me the appointment name and date you want checked.";

interface LocalizedSafetyReplies {
  urgent: string;
  concern: string;
  medical: string;
  optOut: string;
  privacyLegal: string;
  waitRecovery: string;
  strandTest: string;
  booking: string;
}

const LOCALIZED_SAFETY_REPLIES: Record<
  SupportedClientLocale,
  LocalizedSafetyReplies
> = {
  en: {
    urgent: URGENT_SAFETY_REPLY,
    concern: SAFE_CONCERN_REPLY,
    medical: SAFE_MEDICAL_CONCERN_REPLY,
    optOut: SAFE_OPT_OUT_REPLY,
    privacyLegal: SAFE_PRIVACY_LEGAL_REPLY,
    waitRecovery: SAFE_WAIT_RECOVERY_REPLY,
    strandTest: SAFE_STRAND_TEST_REPLY,
    booking: SAFE_BOOKING_REPLY,
  },
  zh: {
    urgent:
      "这可能是紧急情况。请立即拨打新加坡紧急服务 995，或请他人立即送你到最近的急诊部门。立即停止使用该产品，在寻求紧急医疗帮助前不要等待沙龙回复；Hera 团队会在你安全后另行跟进。这不是医疗诊断。",
    concern:
      "很抱歉得知这件事。我已将其记录为优先服务个案，以便谨慎核查事实。请提供预约姓名和日期、发型师（如知道）、事情经过，以及相关清晰照片。在资料审核前，我不会作出假设或承诺退款、赔偿或其他处理，但会在这里把个案资料整理清楚。",
    medical:
      "很抱歉你正经历这些不适。请停止使用该产品或暂停服务。如果疼痛、灼热、肿胀、皮疹、眼睛刺激或其他症状明显或持续恶化，请尽快就医。我已将此记录为 Hera 优先个案；在安全情况下，请提供预约姓名和日期、已知使用产品及清晰照片。这不是医疗诊断。",
    optOut:
      "明白。我已将停止 WhatsApp 消息的要求记录为优先处理事项。Hera 必须在相关消息系统中完成停止发送设置后才算生效；在收到确认前，我不会声称设置已经完成。你无需重复提出要求。",
    privacyLegal:
      "我已将你的隐私或法律请求记录为优先个案。为保护个人资料，任何查阅、更正、删除、监控录像或证据请求都必须先核实身份和范围。请提供预约姓名和日期，并说明所需记录或行动；在核实前，我不会披露资料或承诺结果。",
    waitRecovery:
      "你提出超过 10 分钟的等候是合理的。Hera 已说明的服务补救政策是 10% 折扣。我已记录此情况，但在交易记录确认前，我不会声称账单已更新。",
    strandTest:
      "发束测试失败表示不应继续漂发。头发和客户安全优先于目标发色；较安全的下一步是由发型师制定不违反测试结果的替代方案。",
    booking:
      "我可以协助选择服务和查询已记录的预约资料，但在预约系统确认前，我不会声称预约已更改。请使用 Hera 的安全预约页面：https://bookings.gettimely.com/herabeauty1/bb/book，或告诉我需要查询的预约姓名和日期。",
  },
  ms: {
    urgent:
      "Ini mungkin kecemasan. Sila hubungi perkhidmatan kecemasan Singapura di 995 sekarang, atau minta seseorang membawa anda ke jabatan kecemasan terdekat dengan segera. Hentikan penggunaan produk dan jangan tunggu jawapan salon sebelum mendapatkan bantuan perubatan kecemasan; pasukan Hera akan membuat susulan secara berasingan selepas anda selamat. Ini bukan diagnosis perubatan.",
    concern:
      "Saya minta maaf perkara ini berlaku. Saya telah membuka kes perkhidmatan keutamaan supaya fakta dapat disemak dengan teliti. Sila kongsi nama dan tarikh janji temu, stylist jika diketahui, apa yang berlaku, serta gambar yang jelas jika berkaitan. Saya tidak akan membuat andaian atau menjanjikan bayaran balik, pampasan atau penyelesaian sebelum semakan dibuat.",
    medical:
      "Saya minta maaf anda mengalami keadaan ini. Sila hentikan penggunaan produk atau perkhidmatan itu. Jika sakit, rasa terbakar, bengkak, ruam, iritasi mata atau gejala lain ketara atau semakin teruk, dapatkan rawatan perubatan dengan segera. Saya telah membuka kes Hera keutamaan; apabila selamat, sila kongsi nama dan tarikh janji temu, produk yang digunakan jika diketahui, dan gambar yang jelas. Ini bukan diagnosis perubatan.",
    optOut:
      "Saya faham. Saya telah merekodkan permintaan untuk menghentikan mesej WhatsApp sebagai perkara keutamaan. Hera perlu melaksanakan sekatan itu dalam semua sistem mesej berkaitan sebelum ia dianggap selesai; saya tidak akan mendakwa ia telah selesai sehingga disahkan. Anda tidak perlu mengulangi permintaan ini.",
    privacyLegal:
      "Saya telah merekodkan permintaan privasi atau undang-undang anda sebagai kes keutamaan. Untuk melindungi data peribadi, identiti dan skop mesti disahkan sebelum sebarang akses, pembetulan, pemadaman, CCTV atau bukti boleh diproses. Sila kongsi nama dan tarikh janji temu serta nyatakan rekod atau tindakan yang diminta.",
    waitRecovery:
      "Anda betul untuk membangkitkan masa menunggu melebihi 10 minit. Polisi pemulihan perkhidmatan Hera yang dinyatakan ialah diskaun 10%. Saya telah merekodkan perkara ini, tetapi saya tidak boleh mendakwa bil telah dikemas kini sehingga transaksi disahkan.",
    strandTest:
      "Ujian helai yang gagal bermakna pelunturan tidak patut diteruskan. Keselamatan rambut dan pelanggan mengatasi hasil warna yang diminta; langkah seterusnya yang lebih selamat ialah pelan alternatif yang dipimpin stylist dan tidak mengatasi keputusan ujian.",
    booking:
      "Saya boleh membantu memilih perkhidmatan dan menyemak butiran janji temu yang telah direkodkan, tetapi saya tidak boleh mendakwa perubahan tempahan sehingga sistem tempahan mengesahkannya. Gunakan halaman tempahan selamat Hera: https://bookings.gettimely.com/herabeauty1/bb/book, atau kongsi nama dan tarikh janji temu yang hendak disemak.",
  },
  ta: {
    urgent:
      "இது அவசரநிலையாக இருக்கலாம். சிங்கப்பூர் அவசர சேவையை 995 என்ற எண்ணில் இப்போது அழைக்கவும், அல்லது யாராவது உங்களை உடனடியாக அருகிலுள்ள அவசர சிகிச்சைப் பிரிவுக்கு அழைத்துச் செல்லட்டும். அந்தப் பொருளைப் பயன்படுத்துவதை உடனடியாக நிறுத்துங்கள்; அவசர மருத்துவ உதவியை நாடுவதற்கு முன் சலூனின் பதிலுக்காக காத்திருக்க வேண்டாம். நீங்கள் பாதுகாப்பாக ஆன பின் Hera குழு தனியாகத் தொடர்புகொள்ளும். இது மருத்துவ நோயறிதல் அல்ல.",
    concern:
      "இது நடந்ததற்கு வருந்துகிறேன். உண்மைகளை கவனமாக மதிப்பாய்வு செய்ய முன்னுரிமை சேவை வழக்கைத் திறந்துள்ளேன். முன்பதிவு பெயர் மற்றும் தேதி, தெரிந்தால் stylist, என்ன நடந்தது, தொடர்புடைய தெளிவான படங்கள் ஆகியவற்றைப் பகிரவும். மதிப்பாய்வுக்கு முன் நான் ஊகிக்கவோ பணத்தைத் திருப்பித் தருவதாகவோ இழப்பீடு அல்லது தீர்வை உறுதியளிக்கவோ மாட்டேன்.",
    medical:
      "நீங்கள் இதை அனுபவிப்பதற்கு வருந்துகிறேன். அந்தப் பொருளைப் பயன்படுத்துவதை அல்லது சேவையை நிறுத்துங்கள். வலி, எரிச்சல், வீக்கம், தோல் தடிப்பு, கண் எரிச்சல் அல்லது வேறு அறிகுறிகள் குறிப்பிடத்தக்கதாகவோ மோசமடைந்தாலோ உடனடி மருத்துவ உதவியை நாடுங்கள். முன்னுரிமை Hera வழக்கைத் திறந்துள்ளேன்; பாதுகாப்பாக இருந்ததும் முன்பதிவு பெயர் மற்றும் தேதி, பயன்படுத்திய பொருள், தெளிவான படங்களைப் பகிரவும். இது மருத்துவ நோயறிதல் அல்ல.",
    optOut:
      "புரிகிறது. WhatsApp செய்திகளை நிறுத்துவதற்கான உங்கள் கோரிக்கையை முன்னுரிமையாக பதிவு செய்துள்ளேன். தொடர்புடைய அனைத்து செய்தி அமைப்புகளிலும் தடுப்பு செயல்படுத்தப்பட்ட பிறகே அது நிறைவடைந்ததாகக் கருதப்படும்; உறுதிப்படுத்தப்படும் வரை அது முடிந்துவிட்டதாக நான் கூற மாட்டேன். இந்தக் கோரிக்கையை நீங்கள் மீண்டும் அனுப்ப வேண்டியதில்லை.",
    privacyLegal:
      "உங்கள் தனியுரிமை அல்லது சட்டக் கோரிக்கையை முன்னுரிமை வழக்காக பதிவு செய்துள்ளேன். தனிப்பட்ட தரவைப் பாதுகாக்க, அணுகல், திருத்தம், நீக்கம், CCTV அல்லது ஆதார நடவடிக்கைக்கு முன் அடையாளமும் கோரிக்கையின் வரம்பும் சரிபார்க்கப்பட வேண்டும். முன்பதிவு பெயர் மற்றும் தேதி, வேண்டிய பதிவு அல்லது நடவடிக்கையைத் தெளிவாகக் கூறவும்.",
    waitRecovery:
      "10 நிமிடங்களுக்கு மேல் காத்திருந்ததைச் சுட்டிக்காட்டுவது சரியானது. Hera கூறியுள்ள சேவை மீட்பு கொள்கை 10% தள்ளுபடி. இதை பதிவு செய்துள்ளேன்; பரிவர்த்தனை உறுதியாகும் வரை பில் மாற்றப்பட்டதாக நான் கூற மாட்டேன்.",
    strandTest:
      "strand test தோல்வியடைந்தால் bleach தொடரக்கூடாது. கேட்ட நிற முடிவை விட முடி மற்றும் வாடிக்கையாளர் பாதுகாப்பே முதன்மை; சோதனை முடிவை மீறாத stylist வழிநடத்தும் மாற்றுத் திட்டமே பாதுகாப்பான அடுத்த படி.",
    booking:
      "சரியான சேவையைத் தேர்வுசெய்யவும் ஏற்கனவே பதிவான முன்பதிவு விவரங்களைச் சரிபார்க்கவும் நான் உதவ முடியும்; ஆனால் முன்பதிவு அமைப்பு உறுதிப்படுத்தும் வரை மாற்றம் முடிந்ததாகக் கூற மாட்டேன். Hera-வின் பாதுகாப்பான முன்பதிவு பக்கம்: https://bookings.gettimely.com/herabeauty1/bb/book, அல்லது சரிபார்க்க வேண்டிய பெயர் மற்றும் தேதியை அனுப்பவும்.",
  },
};

function safetyRepliesFor(input: string): LocalizedSafetyReplies {
  return LOCALIZED_SAFETY_REPLIES[detectSupportedClientLocale(input)];
}

export function urgentSafetyReplyFor(input: string): string {
  return safetyRepliesFor(input).urgent;
}

export function isOptOutRequest(input: string): boolean {
  const value = input.slice(0, 20_000);
  return OPT_OUT_PATTERNS.some((pattern) => pattern.test(value));
}

export function highestRisk(...levels: RiskLevel[]): RiskLevel {
  return levels.reduce((highest, level) =>
    RISK_RANK[level] > RISK_RANK[highest] ? level : highest,
  );
}

export function classifyDeterministicRisk(input: string): {
  risk: RiskLevel;
  securityFlags: string[];
} {
  const value = input.slice(0, 20_000);
  const securityFlags = INJECTION_PATTERNS.some((pattern) => pattern.test(value))
    ? ["prompt_injection_attempt"]
    : [];
  if (BLACK_PATTERNS.some((pattern) => pattern.test(value))) {
    return { risk: "black", securityFlags };
  }
  if (RED_PATTERNS.some((pattern) => pattern.test(value))) {
    return { risk: "red", securityFlags };
  }
  if (AMBER_PATTERNS.some((pattern) => pattern.test(value))) {
    return { risk: "amber", securityFlags };
  }
  return { risk: "green", securityFlags };
}

export function assessPolicy(
  input: string,
  decision: AgentDecision,
  priorConversationRisk: RiskLevel = "green",
): PolicyAssessment {
  const deterministic = classifyDeterministicRisk(input);
  const currentRisk = highestRisk(deterministic.risk, decision.risk);
  const risk = highestRisk(currentRisk, priorConversationRisk);
  const replies = safetyRepliesFor(input);
  const blockedActions = UNAUTHORISED_ACTION_PATTERNS.filter((pattern) =>
    pattern.test(decision.reply),
  ).map((pattern) => pattern.source);

  let replyOverride: string | null = null;
  const failedStrandTest =
    /strand test (?:has )?(?:failed|did not pass)|failed (?:the )?strand test/i.test(input);
  const lateBeyondTenMinutes =
    /(?:waited|waiting|wait)\D{0,20}(?:1[1-9]|[2-9][0-9])\s*(?:minutes?|mins?)/i.test(input);
  const medicalConcern =
    decision.intent === "medical_safety" ||
    /allergic|allergy|burn(?:ed|t)?|scalp (?:pain|wound|injury|condition)|hair (?:loss|is falling out|falling out)|pregnan(?:t|cy)|breastfeeding|chemotherapy|\bchemo\b|alopecia|psoriasis|eczema|过敏|灼伤|头皮(?:疼|痛|受伤)|脱发|alahan|alergi|melecur|kulit kepala (?:sakit|cedera)|rambut gugur|ஒவ்வாமை|தீக்காயம்|உச்சந்தலை வலி|முடி உதிர்வு/iu.test(
      input,
    );
  const privacyLegalConcern =
    decision.intent === "privacy_legal" ||
    /lawyer|legal action|court|cctv|evidence request|delete my data|privacy|pdpa|another (?:client|customer)|someone else.{0,32}(?:appointment|records?)|posted (?:my|the) (?:photo|picture).{0,40}(?:without|didn'?t|did not).{0,24}(?:ask|consent|permission)|without my (?:consent|permission)|律师|法律行动|法庭|监控录像|证据|删除(?:我)?(?:的)?数据|隐私|peguam|tindakan undang-undang|mahkamah|rakaman cctv|padam data|privasi|வழக்கறிஞர்|சட்ட நடவடிக்கை|நீதிமன்றம்|தனிப்பட்ட தரவு|தனியுரிமை/iu.test(
      input,
    );
  const optOutRequest = isOptOutRequest(input);

  if (currentRisk === "black") replyOverride = replies.urgent;
  else if (optOutRequest) replyOverride = replies.optOut;
  else if (failedStrandTest) replyOverride = replies.strandTest;
  else if (lateBeyondTenMinutes && blockedActions.length > 0) {
    replyOverride = replies.waitRecovery;
  } else if (blockedActions.length > 0 && decision.intent === "booking") {
    replyOverride = replies.booking;
  } else if (currentRisk === "red" && medicalConcern) {
    replyOverride = replies.medical;
  } else if (currentRisk === "red" && privacyLegalConcern) {
    replyOverride = replies.privacyLegal;
  } else if (blockedActions.length > 0 || currentRisk === "red") {
    replyOverride = replies.concern;
  }

  return {
    risk,
    canAutoSend: true,
    requiresManagementNotification:
      currentRisk === "red" ||
      currentRisk === "black" ||
      decision.requiresManagementNotification,
    requiresIncident:
      currentRisk !== "green" || decision.proposedActions.includes("open_incident"),
    blockedActions,
    securityFlags: deterministic.securityFlags,
    replyOverride,
  };
}
