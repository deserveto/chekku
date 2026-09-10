/**
 * Eval dataset for the Social Media Strategist's critical path
 * ("generate strategi konten" — brand-strategy mode, single turn).
 *
 * Each case is a self-contained Indonesian brief request: the brand
 * context is complete, so the strategist drafts the Content Strategy
 * Brief in ONE turn without interviewing back and without calling
 * search_web/read_web_page (its instructions already skip research when
 * the conversation carries enough context).
 *
 * The golden references (`groundTruth`) were drafted with a capable
 * SOTA model (GLM 5.3, per reference/N11_2.md) and follow the agent's
 * own STRATEGY_BRIEF_TEMPLATE structure. They define expected quality,
 * not expected wording — the judge scorer compares semantic coverage.
 */

export interface SocialStrategyEvalCase {
  id: string;
  /** The full user request, sent verbatim as the agent turn input. */
  input: string;
  /** Golden reference brief used as `groundTruth` by the judge scorer. */
  groundTruth: string;
}

const ATLASFLEET_REQUEST = `Buatkan strategi konten untuk brand kami, AtlasFleet.

AtlasFleet adalah SaaS manajemen armada logistik untuk perusahaan distribusi menengah di Indonesia. Fitur utama kami: pelacakan armada real-time, optimasi rute pengiriman, dan laporan konsumsi BBM per kendaraan.

Tujuan utama konten: membangun brand awareness sebagai mitra teknologi logistik yang kredibel, lalu menghasilkan pertanyaan demo dari manajer operasional.

Target audiens: manajer operasional dan pemilik perusahaan distribusi dengan armada 10–100 kendaraan, umumnya usia 30–45 tahun, aktif di LinkedIn dan Instagram. Masalah terbesar mereka: koordinasi armada masih manual (telefon, spreadsheet), BBM boros tanpa data, dan tidak ada visibilitas posisi kendaraan.

Topik yang ingin kami asosiasikan: transparansi logistik, efisiensi BBM, digitalisasi operasional, dan keamanan pengemudi.

Gaya konten: profesional, edukatif, berbasis data. Hindari gaya salesy, klaim yang menjelek-jelekkan kompetitor, dan jargon teknis berlebihan.

Periode: 1 bulan ke depan.

Deliverable yang saya butuhkan: 8 ide konten untuk LinkedIn dan Instagram dengan format yang sesuai per platform, campuran edukasi dan bukti sosial, dengan cadence mingguan.

Ukuran sukses: dalam 3 bulan, AtlasFleet dianggap referensi edukasi logistik digital dan mulai menerima pertanyaan demo dari konten organik.

Semua konteks sudah lengkap di pesan ini — tidak perlu wawancara balik. Langsung susun brief strateginya.`;

const ATLASFLEET_GOLDEN = `# Content Strategy Brief

Project: AtlasFleet — SaaS manajemen armada logistik untuk perusahaan distribusi menengah di Indonesia
Role: Content Strategist

## Objective

Membangun brand awareness AtlasFleet sebagai mitra teknologi logistik yang kredibel dan berbasis data, dengan jalur konversi menuju pertanyaan demo dari manajer operasional. Strategi ini education-first: kredibilitas dibangun dulu lewat konten yang mengajarkan, bukan lewat promosi fitur — karena audiens B2B Indonesia baru mempertimbangkan vendor teknologi setelah percaya pada penguasaan masalah operasionalnya.

## Target Audience

Primer: manajer operasional perusahaan distribusi dengan armada 10–100 kendaraan, usia 30–45 tahun. Mereka bertanggung jawab pada biaya dan ketepatan pengiriman, di bawah tekanan dari manajemen untuk menekan biaya BBM dan waktu tunggu, tetapi tidak punya waktu membaca konten panjang di jam kerja.

Sekunder: pemilik perusahaan distribusi (pengambil keputusan akhir, sensitif pada ROI dan bukti, bukan fitur teknis).

Kedua segmen aktif di LinkedIn (saat jam kerja, mencari wawasan profesional) dan Instagram (di luar jam kerja, lebih responsif pada format visual pendek).

Pain points yang menjadi pintu masuk konten: koordinasi armada manual lewat telefon dan spreadsheet, konsumsi BBM yang tidak bisa diaudit per kendaraan, dan tidak adanya visibilitas posisi armada.

## Key Topics

1. Transparansi logistik — kenapa pelanggan B2B mulai menuntut visibilitas pengiriman.
2. Efisiensi BBM — cara mengaudit dan menekan konsumsi BBM per kendaraan dengan data.
3. Digitalisasi operasional — kapan waktunya berhenti dari spreadsheet, dan mulai dari mana.
4. Keamanan pengemudi — bagaimana visibilitas armada melindungi pengemudi dan muatan.

## Product / Service Focus

Fitur (muncul natural, tidak lebih dari ~20% slot konten): pelacakan armada real-time, optimasi rute pengiriman, laporan konsumsi BBM per kendaraan. Fitur selalu tampil sebagai jawaban atas masalah yang dibahas, bukan sebagai subjek konten.

## Content Style

Desired: profesional, edukatif, berbasis data; angka dan contoh konkret lebih kuat daripada adjektiva.

Avoid: gaya salesy, klaim yang menjelek-jelekkan kompetitor, jargon teknis berlebihan (AI, IoT, machine learning hanya jika dijelaskan dengan bahasa operasional).

## Deliverables

8 ide konten untuk 1 bulan, tersebar di LinkedIn dan Instagram, cadence 2 konten per minggu (1 LinkedIn + 1 Instagram bergantian), dengan komposisi: 5 edukasi, 2 bukti sosial, 1 produk (soft-sell). Setiap ide menyertakan judul kerja, format, platform, dan tujuan.

## Success Goal

Persepsi: dalam 3 bulan AtlasFleet menjadi referensi edukasi logistik digital yang dirujuk dan dibagikan manajer operasional (indikator: share/save konten LinkedIn, kunjungan profil).

Perilaku: menerima pertanyaan demo yang datang dari konten organik (indikator: DM/lead yang menyebut konten sebagai sumber).

## Expected Output

8 ide konten berikut, siap dieksekusi dalam 4 minggu (minggu 1–4, slot A = LinkedIn, slot B = Instagram):

1. [LinkedIn, carousel edukasi] "5 tanda operasional armada Anda sudah harus digital" — memetakan gejala manual yang familiar (telefon beruntun, spreadsheet tidak sinkron, BBM boros tanpa sebab) ke kebutuhan sistem. Tujuan: kesadaran masalah. (Minggu 1, slot A)
2. [Instagram, reel] "Sehari jadi manajer operasional: 47 telefon sebelum jam 10 pagi" — dramatisasi singkat nyata hari-hari koordinasi manual, diakhiri pertanyaan retoris. Tujuan: relasi emosional + reach baru. (Minggu 1, slot B)
3. [LinkedIn, infografis] "Anatomi biaya logistik per kendaraan per bulan" — memecah komponen biaya (BBM, maintenance, idle time) dengan rentang angka wajar; jadi rujukan yang gampang di-save. Tujuan: otoritas berbasis data. (Minggu 2, slot A)
4. [Instagram, carousel checklist] "Audit armada 10 menit: checklist mingguan manajer operasional" — checklist actionable yang bisa dipakai besok pagi; soft entry ke topik audit BBM. Tujuan: utilitas + save. (Minggu 2, slot B)
5. [LinkedIn, studi kasus] "Studi kasus: menekan konsumsi BBM dua digit dengan optimasi rute" — narasi anonimized sebelum-sesudah, angka konkret, pelajaran yang bisa dipakai tanpa membeli apa pun. Tujuan: bukti sosial. (Minggu 3, slot A)
6. [Instagram, reel demo singkat] "Laporan BBM per kendaraan, 30 detik" — screen demo singkat laporan yang langsung terbaca; tanpa CTA keras. Tujuan: produk sebagai jawaban, bukan iklan. (Minggu 3, slot B)
7. [LinkedIn, opini berbasis data] "Kenapa pelanggan B2B Anda menuntut visibilitas pengiriman" — framing tren transparansi logistik dari sisi pelanggan distributor. Tujuan: thought leadership. (Minggu 4, slot A)
8. [Instagram + LinkedIn, pengumuman sesi tanya jawab] "Tanya jawab: digitalisasi armada untuk armada 10–100 kendaraan" — sesi live/AMA ringkas yang mengubah pembaca jadi percakapan (jalur demo). Tujuan: konversi percakapan. (Minggu 4, slot B)

Catatan cadence: dua konten per minggu menjaga kualitas produksi untuk tim kecil; format carousel/infografis diprioritaskan karena umur panjang dan mudah dibagikan ulang.`;

const TUMBUH_REQUEST = `Buatkan strategi konten untuk Tumbuh, aplikasi mobile pencatat keuangan untuk pekerja baru di Indonesia.

Fitur utama kami: pencatatan pengeluaran otomatis dari notifikasi e-wallet dan m-banking, tabungan tujuan dengan target visual, dan laporan bulanan yang mudah dibaca.

Tujuan utama konten: akuisisi pengguna baru dan edukasi literasi keuangan dasar.

Target audiens: pekerja baru usia 22–30 tahun di kota besar, baru menerima gaji pertama atau baru 1–2 tahun kerja, bingung membagi uang, aktif di Instagram dan TikTok, dan malu bertanya soal keuangan ke siapa pun.

Topik yang ingin kami asosiasikan: gaji pertama, kebiasaan nabung kecil, beda kebutuhan vs keinginan, dan uang jajan tanpa rasa bersalah.

Gaya konten: santai, ramah, membumi — seperti kakak yang pernah merasakan hal yang sama. Hindari nada menggurui, menghakimi kebiasaan belanja, dan istilah finansial berat seperti "diversifikasi aset" atau "allocation".

Periode: 1 bulan ke depan.

Deliverable yang saya butuhkan: 10 ide konten untuk Instagram dan TikTok, mayoritas format reels/video pendek, cadence 3–4 konten per minggu, termasuk ide konten interaktif yang mengundang komentar.

Ukuran sukses: dalam 3 bulan, Tumbuh dianggap "teman pertama" saat mulai mengatur keuangan dan install organik naik.

Semua konteks sudah lengkap di pesan ini — tidak perlu wawancara balik. Langsung susun brief strateginya ya.`;

const TUMBUH_GOLDEN = `# Content Strategy Brief

Project: Tumbuh — aplikasi mobile pencatat keuangan untuk pekerja baru di Indonesia
Role: Content Strategist

## Objective

Akuisisi pengguna baru melalui edukasi literasi keuangan dasar yang terasa seperti dukungan teman, bukan kuliah. Strategi ini dibangun di atas satu insight: audiens malu bertanya soal uang, jadi konten Tumbuh harus menjadi "pertanyaan yang belum berani mereka tanyakan" — dijawab dengan hangat dan tanpa menghakimi. Kepercayaan dulu, install menyusul.

## Target Audience

Pekerja baru usia 22–30 tahun di kota besar Indonesia: baru menerima gaji pertama atau baru 1–2 tahun kerja. Gaji pas-pasan di kota dengan biaya hidup tinggi, pengeluaran terjadi di e-wallet dan QRIS (jarang tunai), dan tabungan kalau ada selalu terpakai di akhir bulan.

Perilaku media: aktif di Instagram dan TikTok, menonton reels/video pendek di jam istirahat dan sebelum tidur; mengikuti kreator lifestyle dan relatable content; lebih percaya konten yang jujur soal kesulitan daripada konten yang terlihat sempurna.

Halangan terbesar: malu bertanya dan takut dihakimi "kok gajinya segitu habis segini".

## Key Topics

1. Gaji pertama — keputusan-keputusan kecil pertama yang membentuk kebiasaan.
2. Kebiasaan nabung kecil — mulai dari nominal yang terasa tidak sakit.
3. Kebutuhan vs keinginan — cara membedakan yang tidak bikin merasa bersalah.
4. Uang jajan tanpa rasa bersalah — menikmati uang tanpa kehilangan kendali.

## Product / Service Focus

Fitur (muncul natural, tidak lebih dari ~20% slot konten): pencatatan otomatis dari notifikasi e-wallet/m-banking, tabungan tujuan dengan target visual, laporan bulanan yang mudah dibaca. Fitur diposisikan sebagai "yang bantu mikirin", bukan alat disiplin yang menghukum.

## Content Style

Desired: santai, ramah, membumi — suara kakak yang pernah merasakan hal yang sama; bahasa percakapan sehari-hari; humor ringan boleh.

Avoid: nada menggurui, menghakimi kebiasaan belanja, istilah finansial berat ("diversifikasi aset", "allocation", "instrument").

## Deliverables

10 ide konten untuk 1 bulan di Instagram dan TikTok, mayoritas reels/video pendek, cadence 3–4 konten per minggu, dengan minimal 3 ide interaktif yang mengundang komentar/jawaban audiens.

## Success Goal

Persepsi: dalam 3 bulan, Tumbuh menjadi "teman pertama" yang dicari saat seseorang mulai mengatur keuangan (indikator: komentar relatable, share ke teman, menyebut Tumbuh di percakapan).

Perilaku: kenaikan install organik yang tertelusur dari konten (indikator: install dari tautan bio/video, lonjakan pasca unggahan).

## Expected Output

10 ide konten berikut untuk 4 minggu (minggu 1–4; format berulang mingguan ditandai):

1. [TikTok + IG reels] "POV: gaji pertama masuk, 3 hal yang sebaiknya kamu lakukan hari ini" — sketsa singkat dan hangat, tanpa angka yang menggurui. Tujuan: hook emosional pertama kenalan. (Minggu 1)
2. [TikTok + IG reels, interaktif] "Kebutuhan atau keinginan? Uji 5 pembelian terakhir kamu" — menantang penonton menilai pembeliannya sendiri di kolom komentar. Tujuan: interaksi + edukasi ringan. (Minggu 1)
3. [IG carousel] "Jatah jajan tanpa rasa bersalah: cara 3 amplop" — membagi uang jajan mingguan ke tiga amplop (senang hari ini / senang akhir pekan / cadangan), tanpa kata "disiplin". Tujuan: save + utilitas. (Minggu 1)
4. [TikTok] "Nabung Rp10.000 sehari: coba 7 hari bareng aku" — tantangan kecil yang dijalani kreator sendiri, ditutup dengan ajakan share hasil. Tujuan: kebiasaan kecil + partisipasi. (Minggu 2)
5. [IG reels, demo 15 detik] "Notifikasi e-wallet-mu, tercatat otomatis" — demo super singkat pencatatan otomatis di momen real (baru bayar kopi). Tujuan: produk sebagai kejutan yang membantu. (Minggu 2)
6. [TikTok, interaktif] "Bahas komentar: 'gaji segini cukup nggak hidup di Jakarta?'" — menjawab 2–3 komentar nyata dengan empati dan hitungan sederhana. Tujuan: kedekatan + menjawab rasa malu bertanya. (Minggu 2)
7. [TikTok + IG reels] "Tabungan tujuan: beli barang impian dalam 4 bulan, ini hitungannya" — target visual (contoh: headphone) dihitung mundur jadi nominal harian. Tujuan: menghubungkan impian dengan kebiasaan kecil. (Minggu 3)
8. [IG carousel] "Laporan bulanan kamu cuma perlu lihat 3 angka ini" — menyederhanakan laporan bulanan: masuk, keluar, sisa; tanpa istilah teknis. Tujuan: edukasi + kaitan fitur laporan. (Minggu 3)
9. [TikTok] "5 kalimat keuangan yang bikin overthinking — versi jujur" — membongkar kalimat toksik ("jangan beli kopi kalau mau kaya") dengan sudut pandang seimbang. Tujuan: posisi anti-penghakiman. (Minggu 4)
10. [IG story polling — format mingguan berulang] "Minggu ini uangmu lebih banyak habis untuk..." — polling ceria mingguan yang hasilnya jadi bahan konten minggu berikutnya. Tujuan: interaksi berkelanjutan + riset audiens. (Mulai minggu 1, berulang)

Catatan cadence: 3 konten utama per minggu + story polling mingguan; minggu ke-4 dapat ditambah 1 konten jika performa polling menunjukkan topik yang dicari audiens.`;

export const SOCIAL_STRATEGY_EVAL_CASES: SocialStrategyEvalCase[] = [
  { id: 'b2b-saas-logistics', input: ATLASFLEET_REQUEST, groundTruth: ATLASFLEET_GOLDEN },
  { id: 'consumer-finance-app', input: TUMBUH_REQUEST, groundTruth: TUMBUH_GOLDEN },
];
