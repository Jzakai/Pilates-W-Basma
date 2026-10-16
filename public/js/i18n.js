// English / Arabic for the client pages. Load before common.js.
//
// t('English text', { vars }) returns the Arabic text when Arabic is on, otherwise the English.
// Keys are the English strings themselves, with {placeholders}. Text in the HTML is translated
// when the page loads, and strings passed to el() are translated as they are added.

var LANG = (() => {
  try {
    return localStorage.getItem('lang') === 'ar' ? 'ar' : 'en';
  } catch {
    return 'en';
  }
})();

const AR = {
  // ---------------------------------------------------------------- header & common
  'Timetable': 'الجدول',
  'How it works': 'طريقة الحجز',
  'Sign in': 'تسجيل الدخول',
  'My account': 'حسابي',
  'Something went wrong. Please try again.': 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
  '{name} — Book a class': '{name} — احجزي حصة',

  // ------------------------------------------------------------------- home page
  'See classes & book': 'الحصص والحجز',
  'How booking works': 'طريقة الحجز',
  'Create an account': 'أنشئي حسابًا',
  'Takes a minute, only once': 'دقيقة واحدة، ولمرة واحدة فقط',
  'Sign up with your email, phone / WhatsApp number, any injuries and your activity level, so Basma knows who is coming.':
    'سجّلي بريدك الإلكتروني ورقم الجوال / واتساب وأي إصابات ومستوى نشاطك، حتى تعرف بسمة من سيحضر.',
  'Pick your classes': 'اختاري حصصك',
  'Select one or more, then tap Book': 'اختاري حصة أو أكثر ثم اضغطي «احجزي»',
  'Online booking closes {cutoff} before each class. If a class is full, join the waiting list: you\'ll get an email if a spot opens and have {offer} to claim it.':
    'يُغلق الحجز الإلكتروني قبل {cutoff} من موعد كل حصة. إذا كانت الحصة مكتملة، انضمي إلى قائمة الانتظار: ستصلكِ رسالة بالبريد الإلكتروني إذا توفر مكان، ويكون أمامكِ {offer} لتأكيده.',
  'Pay by transfer': 'ادفعي بالتحويل',
  'Bank or STC Pay, then upload the receipt': 'تحويل بنكي أو STC Pay، ثم ارفعي الإيصال',
  'Pay straight away or later from My account, any credit you have is used first. Unpaid spots are released {deadline} before class, and you\'ll get a reminder before then.':
    'ادفعي مباشرة أو لاحقًا من «حسابي»، ويُستخدم رصيدكِ أولًا إن وجد. تُلغى الحجوزات غير المدفوعة قبل {deadline} من موعد الحصة، وسيصلكِ تذكير قبل ذلك.',
  'You\'re in': 'تم الحجز',
  'Confirmation email with a calendar invite': 'رسالة تأكيد مع دعوة للتقويم',
  'Basma checks your receipt and you get a confirmation by email. Can\'t make it? Cancel from My account up to {cancel} before class and the fee comes back as credit for another class.':
    'تراجع بسمة الإيصال وتصلكِ رسالة تأكيد بالبريد الإلكتروني. لا تستطيعين الحضور؟ ألغي الحجز من «حسابي» قبل {cancel} على الأقل من موعد الحصة، ويُعاد المبلغ رصيدًا لحصة أخرى.',
  'Loading classes…': 'جارٍ تحميل الحصص…',
  'This week': 'هذا الأسبوع',
  'Week of {date}': 'أسبوع {date}',
  'No classes are scheduled at the moment — check back soon.': 'لا توجد حصص مجدولة حاليًا — تابعينا قريبًا.',
  'Cancelled': 'ملغاة',
  'You’re booked': 'محجوزة لكِ',
  'Receipt being checked': 'الإيصال قيد المراجعة',
  'Booked · payment due': 'محجوزة · بانتظار الدفع',
  'My bookings': 'حجوزاتي',
  'Spot offered to you!': 'توفر مكان لكِ!',
  'On waiting list': 'في قائمة الانتظار',
  'View': 'عرض',
  'Full': 'مكتملة',
  'Full · {n} waiting': 'مكتملة · {n} في الانتظار',
  'Join waiting list': 'انضمي لقائمة الانتظار',
  'Booking closed': 'الحجز مغلق',
  '1 spot left': 'بقي مكان واحد',
  '{n} spots left': 'أماكن متبقية: {n}',
  '✓ Selected': '✓ تم الاختيار',
  'Select': 'اختيار',
  '{ampm} · {n} min': '{ampm} · {n} دقيقة',
  '{n} class selected · {total}': 'حصة واحدة · {total}',
  '{n} classes selected · {total}': 'عدد الحصص: {n} · {total}',
  'Book class': 'احجزي الحصة',
  'Book classes': 'احجزي الحصص',
  'Book': 'احجزي',
  'Clear': 'مسح',
  'You\'re number {n} on the waiting list for {title}, {when}. We\'ll email you if a spot opens up.':
    'ترتيبكِ {n} في قائمة الانتظار لحصة {title}، {when}. سنراسلكِ بالبريد الإلكتروني إذا توفر مكان.',
  'Pilates': 'بيلاتس',
  'Mat Pilates for all levels.': 'بيلاتس على الحصيرة لجميع المستويات.',

  // ------------------------------------------------------------ sign in / sign up
  'Sign in to book classes, upload payment receipts and manage your bookings.':
    'سجّلي الدخول لحجز الحصص ورفع إيصالات الدفع وإدارة حجوزاتكِ.',
  'Email': 'البريد الإلكتروني',
  'Password': 'كلمة المرور',
  'Forgot your password?': 'نسيتِ كلمة المرور؟',
  'New here?': 'جديدة هنا؟',
  'Reset your password': 'إعادة تعيين كلمة المرور',
  'Enter your email and we\'ll send you a link to choose a new password.':
    'أدخلي بريدكِ الإلكتروني وسنرسل لكِ رابطًا لاختيار كلمة مرور جديدة.',
  'Send reset link': 'أرسلي الرابط',
  'Back to sign in': 'العودة لتسجيل الدخول',
  'If an account exists for {email}, we\'ve emailed a reset link. It works for 1 hour.':
    'إذا كان هناك حساب مسجل بـ {email}، فقد أرسلنا رابط إعادة التعيين. الرابط صالح لمدة ساعة واحدة.',
  'Create account': 'إنشاء حساب',
  'Create your account': 'أنشئي حسابكِ',
  'Your details are saved so you don\'t have to enter them every time you book.':
    'تُحفظ بياناتكِ حتى لا تحتاجي لإدخالها في كل حجز.',
  'Create an account to finish booking. Your details are saved for next time.':
    'أنشئي حسابًا لإكمال الحجز. تُحفظ بياناتكِ للمرة القادمة.',
  'Full name': 'الاسم الكامل',
  'Phone / WhatsApp number': 'رقم الجوال / واتساب',
  'Phone / WhatsApp': 'الجوال / واتساب',
  'Activity level': 'مستوى النشاط',
  'Choose…': 'اختاري…',
  'Not very active': 'نشاط قليل',
  'Somewhat active': 'نشاط متوسط',
  'Very active': 'نشاط عالٍ',
  'Any injuries or limitations?': 'هل لديكِ إصابات أو قيود صحية؟',
  '(optional — only the instructor sees this)': '(اختياري — تراه المدربة فقط)',
  '(at least 8 characters)': '(8 أحرف على الأقل)',
  'Already have an account?': 'لديكِ حساب؟',
  'Reset password': 'إعادة تعيين كلمة المرور',
  'Choose a new password': 'اختاري كلمة مرور جديدة',
  'New password': 'كلمة المرور الجديدة',
  'Save password': 'حفظ كلمة المرور',

  // ----------------------------------------------------------------- my account
  'Hi, {name}': 'أهلًا {name}',
  'Sign out': 'تسجيل الخروج',
  'Pending payments': 'مدفوعات معلقة',
  'Waiting list': 'قائمة الانتظار',
  'Credits': 'الرصيد',
  'Past & cancelled': 'السابقة والملغاة',
  'Profile': 'الملف الشخصي',
  'Credit is added when you cancel a paid class in time or a class is cancelled by the studio. Use it to pay for any class.':
    'يُضاف الرصيد عند إلغائكِ حصة مدفوعة في الوقت المحدد أو عند إلغاء الاستوديو للحصة. يمكنكِ استخدامه للدفع لأي حصة.',
  'Injuries or limitations': 'الإصابات أو القيود الصحية',
  '(only the instructor sees this)': '(تراه المدربة فقط)',
  'Save changes': 'حفظ التغييرات',
  'Payment due': 'بانتظار الدفع',
  'Confirmed': 'مؤكدة',
  'Choose the classes you\'re paying for, transfer the total and upload the receipt. You can pay for several classes with one transfer. Unpaid spots are released {deadline} before class.':
    'اختاري الحصص التي تدفعين لها، وحوّلي المبلغ الإجمالي ثم ارفعي الإيصال. يمكنكِ الدفع لعدة حصص بتحويل واحد. تُلغى الحجوزات غير المدفوعة قبل {deadline} من موعد الحصة.',
  'Nothing to pay right now.': 'لا توجد مدفوعات حاليًا.',
  '{when} · pay by {deadline}': '{when} · الدفع قبل {deadline}',
  'Total': 'المجموع',
  'Use my credit ({credit})': 'استخدمي رصيدي ({credit})',
  'Transfer receipt': 'إيصال التحويل',
  '(photo or PDF, up to {mb} MB)': '(صورة أو PDF، حتى {mb} ميغابايت)',
  'Your last receipt was not accepted: {reason}. Please upload a correct one.':
    'لم يُقبل إيصالكِ الأخير: {reason}. يرجى رفع الإيصال الصحيح.',
  'Upload receipt': 'رفع الإيصال',
  '{transfer} to transfer (+ {credit} from credit)': '{transfer} للتحويل (+ {credit} من الرصيد)',
  'Pay with credit': 'الدفع من الرصيد',
  'Please attach your transfer receipt.': 'يرجى إرفاق إيصال التحويل.',
  'The receipt must be smaller than {mb} MB.': 'يجب أن يكون حجم الإيصال أقل من {mb} ميغابايت.',
  'Uploading…': 'جارٍ الرفع…',
  '{n} class paid with credit and confirmed.': 'تم دفع حصة واحدة من الرصيد وتأكيدها.',
  '{n} classes paid with credit and confirmed.': 'تم دفع {n} حصص من الرصيد وتأكيدها.',
  'Receipt uploaded — {who} will check it and you\'ll get a confirmation email.':
    'تم رفع الإيصال — ستراجعه {who} وستصلكِ رسالة تأكيد بالبريد الإلكتروني.',
  'the studio': 'الاستوديو',
  'Basma': 'بسمة',
  'You can cancel online up to {cancel} before class. Paid classes are returned to you as credit.':
    'يمكنكِ الإلغاء إلكترونيًا حتى {cancel} قبل موعد الحصة. يُعاد مبلغ الحصص المدفوعة رصيدًا لكِ.',
  'Add to calendar': 'أضيفي للتقويم',
  'Cancel': 'إلغاء',
  'No upcoming classes.': 'لا توجد حصص قادمة.',
  'Book a class': 'احجزي حصة',
  'Cancel {title} on {when}?': 'إلغاء حصة {title} يوم {when}؟',
  '{amount} will be added to your account credit.': 'سيُضاف {amount} إلى رصيد حسابكِ.',
  'Your booking has been cancelled.': 'تم إلغاء حجزكِ.',
  '{when} · a spot is held for you until {deadline}': '{when} · المكان محجوز لكِ حتى {deadline}',
  '{when} · number {n} in line': '{when} · ترتيبكِ {n}',
  'Claim spot': 'أكّدي المكان',
  'Waiting': 'في الانتظار',
  'Leave': 'خروج',
  'You\'re not on any waiting lists.': 'لستِ في أي قائمة انتظار.',
  'The spot is yours! Please pay for it below to confirm.': 'المكان لكِ! يرجى الدفع أدناه لتأكيده.',
  'Leave the waiting list for {title}?': 'الخروج من قائمة الانتظار لحصة {title}؟',
  'No credit history yet.': 'لا يوجد سجل للرصيد بعد.',
  'Paid for a class': 'دفع لحصة',
  'Payment for a cancelled class': 'دفعة لحصة ملغاة',
  'Class cancelled by the studio': 'ألغى الاستوديو الحصة',
  'Cancelled a class': 'إلغاء حصة',
  'Saved.': 'تم الحفظ.',
  'Nothing here yet.': 'لا يوجد شيء هنا بعد.',
  'cancelled by client': 'ألغيتِها',
  'unpaid': 'لم تُدفع في الوقت المحدد',
  'cancelled by studio': 'ألغاها الاستوديو',
  'class cancelled': 'أُلغيت الحصة',
  '{n} class reserved. Pay below now, or come back later before the deadline.':
    'تم حجز حصة واحدة. ادفعي أدناه الآن، أو عودي لاحقًا قبل الموعد النهائي.',
  '{n} classes reserved. Pay below now, or come back later before the deadline.':
    'تم حجز {n} حصص. ادفعي أدناه الآن، أو عودي لاحقًا قبل الموعد النهائي.',
  'One class could not be booked: {error}': 'تعذّر حجز إحدى الحصص: {error}',

  // ------------------------------------------------------------ server messages
  'An account with this email already exists. Please sign in.': 'يوجد حساب بهذا البريد الإلكتروني. يرجى تسجيل الدخول.',
  'Booking not found.': 'الحجز غير موجود.',
  'Booking is not active.': 'الحجز غير نشط.',
  'Class is full.': 'الحصة مكتملة.',
  'Class not found.': 'الحصة غير موجودة.',
  'Email or password is incorrect.': 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
  'Good news — a spot is available, you can book it now!': 'خبر سار — توفر مكان، يمكنكِ حجزه الآن!',
  'Not found.': 'غير موجود.',
  'One of these classes is not waiting for payment any more. Please refresh.': 'إحدى هذه الحصص لم تعد بانتظار الدفع. يرجى تحديث الصفحة.',
  'Password is too long.': 'كلمة المرور طويلة جدًا.',
  'Password must be at least 8 characters.': 'يجب أن تتكون كلمة المرور من 8 أحرف على الأقل.',
  'Please attach your bank transfer receipt.': 'يرجى إرفاق إيصال التحويل البنكي.',
  'Please book at most 20 classes at a time.': 'يمكنكِ حجز 20 حصة كحد أقصى في المرة الواحدة.',
  'Please choose at least one class.': 'يرجى اختيار حصة واحدة على الأقل.',
  'Please choose the classes you are paying for.': 'يرجى اختيار الحصص التي تدفعين لها.',
  'Please choose your activity level.': 'يرجى اختيار مستوى النشاط.',
  'Please enter a valid email address.': 'يرجى إدخال بريد إلكتروني صحيح.',
  'Please enter your name.': 'يرجى إدخال اسمكِ.',
  'Please enter your phone / WhatsApp number.': 'يرجى إدخال رقم الجوال / واتساب.',
  'Please upload the receipt as a photo (JPG, PNG, HEIC) or a PDF.': 'يرجى رفع الإيصال كصورة (JPG أو PNG أو HEIC) أو ملف PDF.',
  'Receipt not found.': 'الإيصال غير موجود.',
  'Sorry, this offer is no longer available.': 'عذرًا، لم يعد هذا العرض متاحًا.',
  'The payment deadline for one of these classes has passed.': 'انتهى موعد الدفع لإحدى هذه الحصص.',
  'This booking is already cancelled.': 'هذا الحجز ملغى بالفعل.',
  'This class has been cancelled.': 'أُلغيت هذه الحصة.',
  'This class is full.': 'هذه الحصة مكتملة.',
  'This class is no longer taking waiting-list sign-ups.': 'لم تعد هذه الحصة تقبل التسجيل في قائمة الانتظار.',
  'This reset link has expired. Please request a new one.': 'انتهت صلاحية رابط إعادة التعيين. يرجى طلب رابط جديد.',
  'Waiting list entry not found.': 'التسجيل في قائمة الانتظار غير موجود.',
  'You are already booked into this class.': 'أنتِ محجوزة في هذه الحصة بالفعل.',
  'You are already on the waiting list for this class.': 'أنتِ في قائمة الانتظار لهذه الحصة بالفعل.',
  'You are not on this waiting list any more.': 'لم تعودي في قائمة الانتظار هذه.',
  'Too many attempts. Please wait a few minutes and try again.': 'محاولات كثيرة. يرجى الانتظار بضع دقائق ثم المحاولة مرة أخرى.',
  'Please sign in first.': 'يرجى تسجيل الدخول أولًا.',
  'The upload could not be read.': 'تعذّرت قراءة الملف المرفوع.',
  'Invalid request.': 'طلب غير صالح.',
};

// Server messages that contain numbers.
const AR_PATTERNS = [
  [/^Online booking closes (\d+) hours before class\.$/, (h) => `يُغلق الحجز الإلكتروني قبل ${duration(Number(h))} من موعد الحصة.`],
  [/^Online cancellation closes (\d+) hours before class\. Please contact the studio\.$/,
    (h) => `يُغلق الإلغاء الإلكتروني قبل ${duration(Number(h))} من موعد الحصة. يرجى التواصل مع الاستوديو.`],
  [/^The receipt must be smaller than (\d+) MB\.$/, (mb) => `يجب أن يكون حجم الإيصال أقل من ${mb} ميغابايت.`],
];

function fill(text, vars) {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : text;
}

// Money amounts like "SAR 30" (from the server or money()) → "30 ر.س".
const arMoney = (s) => s.replace(/SAR\s?([\d.,]+)/g, '$1 ر.س');

function t(text, vars) {
  if (LANG !== 'ar' || typeof text !== 'string') return fill(String(text), vars);
  if (AR[text]) return arMoney(fill(AR[text], vars));
  const trimmed = text.trim();
  if (trimmed !== text && AR[trimmed]) return text.replace(trimmed, arMoney(fill(AR[trimmed], vars)));
  for (const [re, fn] of AR_PATTERNS) {
    const m = text.match(re);
    if (m) return fn(...m.slice(1));
  }
  return arMoney(fill(text, vars));
}

// Like t(), but returns nodes so the values can be shown in bold.
function tNodes(text, vars) {
  const template = LANG === 'ar' && AR[text] ? AR[text] : text;
  return template.split(/(\{\w+\})/).filter(Boolean).map((part) => {
    const key = part.match(/^\{(\w+)\}$/)?.[1];
    if (!key || !(key in vars)) return document.createTextNode(part);
    const b = document.createElement('b');
    b.textContent = vars[key];
    return b;
  });
}

// 48 → "2 days" / "يومان", 12 → "12 hours" / "12 ساعة".
function duration(hours) {
  const days = hours % 24 === 0;
  const n = days ? hours / 24 : hours;
  if (LANG !== 'ar') return `${n} ${days ? 'day' : 'hour'}${n === 1 ? '' : 's'}`;
  if (days) return n === 1 ? 'يوم واحد' : n === 2 ? 'يومين' : n <= 10 ? `${n} أيام` : `${n} يومًا`;
  return n === 1 ? 'ساعة واحدة' : n === 2 ? 'ساعتين' : n <= 10 ? `${n} ساعات` : `${n} ساعة`;
}

// Dates in the chosen language, with the Gregorian calendar and Latin digits.
var DATE_LOCALE = LANG === 'ar' ? 'ar-u-ca-gregory-nu-latn' : 'en-GB';
const ampm = (pm) => (LANG === 'ar' ? (pm ? 'م' : 'ص') : pm ? 'pm' : 'am');

// Translates the text already in the page: text nodes and a few attributes that match a key.
function translateTree(root) {
  if (LANG !== 'ar') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const trimmed = node.nodeValue.trim();
    if (trimmed && AR[trimmed]) node.nodeValue = node.nodeValue.replace(trimmed, AR[trimmed]);
  }
  for (const elem of root.querySelectorAll('[placeholder], [title], [aria-label]')) {
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      const v = elem.getAttribute(attr);
      if (v && AR[v]) elem.setAttribute(attr, AR[v]);
    }
  }
}

function setLanguage(lang) {
  try {
    localStorage.setItem('lang', lang);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
  location.reload();
}

(function applyLanguage() {
  const html = document.documentElement;
  html.lang = LANG;
  html.dir = LANG === 'ar' ? 'rtl' : 'ltr';
  if (LANG === 'ar') {
    const font = document.createElement('link');
    font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600&display=swap';
    document.head.append(font);
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (AR[document.title]) document.title = AR[document.title];
    translateTree(document.body);
    const nav = document.querySelector('.site-header .nav');
    if (nav) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'lang-toggle';
      toggle.lang = LANG === 'ar' ? 'en' : 'ar';
      toggle.textContent = LANG === 'ar' ? 'English' : 'العربية';
      toggle.addEventListener('click', () => setLanguage(LANG === 'ar' ? 'en' : 'ar'));
      nav.prepend(toggle);
    }
  });
})();
