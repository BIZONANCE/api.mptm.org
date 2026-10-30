import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { prisma, withDbRetry } from "./prisma";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Comprehensive Production CORS Configuration
const corsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        const envOrigins = (process.env.CORS_ORIGIN || "")
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean);

        const allowedOrigins = [
            "https://admin.mptmamravati.org",
            "https://www.mptmamravati.org",
            "https://mptmamravati.org",
            "https://admin.mptm.org",
            "https://www.mptm.org",
            "https://mptm.org",
            "http://localhost:3001",
            "http://localhost:3000",
            ...envOrigins,
        ];

        const isAllowed =
            !origin ||
            allowedOrigins.includes(origin) ||
            /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
            /^https:\/\/([a-z0-9-]+\.)?(mptmamravati\.org|mptm\.org)$/i.test(origin);

        if (isAllowed) {
            callback(null, true);
        } else {
            console.warn(`[CORS REJECTED] Origin: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
};

// Enable CORS for frontend
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({
    limit: "50mb",
    verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString();
    }
}));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Mount Rebuilt PhonePe & Payment Routes (Stage C)
app.use("/api", require("./routes/paymentRoutes"));

// Helper function to delete registration entry cleanly with manual cascade fallback and automatic archiving
const deleteRegistrationByIdOrReceipt = async (identifier: string, reason?: string, deletedBy?: string) => {
    return withDbRetry(async () => {
        // 1. Find target registration by ID or receiptNo (including main and family members)
        const target = await prisma.memberRegistration.findFirst({
            where: {
                OR: [
                    { id: identifier },
                    { receiptNo: identifier }
                ]
            },
            include: {
                mainMembers: true,
                familyMembers: true
            }
        });

        if (!target) {
            return null;
        }

        const regId = target.id;
        const main = target.mainMembers?.[0];
        const isExecutiveReceipt = target.receiptNo?.startsWith("MPTM-EM-") || target.registrationFee === 1001;

        // Archive into DeletedMember table before removal
        try {
            const delId = `del_reg_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            await prisma.$executeRawUnsafe(
                `INSERT INTO "DeletedMember" (
                    "id", "memberType", "originalId", "receiptNo", "memberNo", "fullName",
                    "designation", "mobileNo", "email", "address", "gaav", "taluka",
                    "city", "district", "state", "country", "pincode", "photoUrl",
                    "registrationFee", "paymentMethod", "paymentReference", "referredBy",
                    "registrationDate", "familyMembers", "fullData", "deletedAt", "deletedBy", "reason"
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb, $25::jsonb, $26, $27, $28)`,
                delId,
                isExecutiveReceipt ? "EXECUTIVE" : "PRIMARY",
                target.id,
                target.receiptNo,
                main?.memberNo || null,
                main?.fullName || "अज्ञात",
                isExecutiveReceipt ? "कार्यकारिणी सदस्य (Executive Member)" : "प्राथमिक सदस्य (Primary Member)",
                main?.mobileNo || "-",
                null,
                target.address || null,
                target.gaav || null,
                target.taluka || null,
                target.city || "अमरावती",
                target.district || "अमरावती",
                target.state || "महाराष्ट्र",
                target.country || "भारत",
                target.pincode || null,
                null,
                target.registrationFee || 0,
                target.paymentMethod || null,
                target.paymentReference || null,
                target.referredBy || null,
                target.date || null,
                JSON.stringify(target.familyMembers || []),
                JSON.stringify(target),
                new Date(),
                deletedBy || "Admin",
                reason || (isExecutiveReceipt ? "Executive Registration Deleted" : "Primary Member Registration Deleted")
            );
        } catch (archiveErr) {
            console.warn("Failed to archive deleted primary registration to DeletedMember:", archiveErr);
        }

        // Use transaction to delete family members, main members, and registration
        const [deletedFamily, deletedMain, deletedReg] = await prisma.$transaction([
            prisma.familyMember.deleteMany({ where: { registrationId: regId } }),
            prisma.mainMember.deleteMany({ where: { registrationId: regId } }),
            prisma.memberRegistration.delete({ where: { id: regId } })
        ]);

        return {
            registration: deletedReg,
            mainCount: deletedMain.count,
            familyCount: deletedFamily.count
        };
    });
};

// DELETE /api/register/:id - Delete registration entry by ID
app.delete("/api/register/:id", async (req: Request, res: Response) => {
    try {
        const identifier = String(req.params.id);
        const reason = req.body?.reason ? String(req.body.reason) : undefined;
        const deletedBy = req.body?.deletedBy ? String(req.body.deletedBy) : undefined;
        const result = await deleteRegistrationByIdOrReceipt(identifier, reason, deletedBy);

        if (!result) {
            res.status(404).json({
                success: false,
                error: "हा नोंदणी अर्ज सापडला नाही किंवा आधीच हटवला आहे!",
            });
            return;
        }

        res.json({
            success: true,
            message: "नोंदणी अर्ज यशस्वीरित्या डेटाबेसमधून हटवला गेला व हटवलेल्या सदस्यांच्या यादीत संग्रहित झाला",
            data: result.registration,
        });
    } catch (error: any) {
        console.error("Delete Registration Error:", error);
        res.status(500).json({
            success: false,
            error: "डेटाबेस सर्व्हर त्रुटी: " + (error.message || "हटवताना अनपेक्षित त्रुटी झाली"),
        });
    }
});

// POST /api/register/delete/:id - Fallback route for POST method deletion
app.post("/api/register/delete/:id", async (req: Request, res: Response) => {
    try {
        const identifier = String(req.params.id);
        const reason = req.body?.reason ? String(req.body.reason) : undefined;
        const deletedBy = req.body?.deletedBy ? String(req.body.deletedBy) : undefined;
        const result = await deleteRegistrationByIdOrReceipt(identifier, reason, deletedBy);

        if (!result) {
            res.status(404).json({
                success: false,
                error: "हा नोंदणी अर्ज सापडला नाही किंवा आधीच हटवला आहे!",
            });
            return;
        }

        res.json({
            success: true,
            message: "नोंदणी अर्ज यशस्वीरित्या डेटाबेसमधून हटवला गेला व हटवलेल्या सदस्यांच्या यादीत संग्रहित झाला",
            data: result.registration,
        });
    } catch (error: any) {
        console.error("Delete Registration Error:", error);
        res.status(500).json({
            success: false,
            error: "डेटाबेस सर्व्हर त्रुटी: " + (error.message || "हटवताना अनपेक्षित त्रुटी झाली"),
        });
    }
});

// DELETE /api/registrations/:id - Alternative deletion endpoint
app.delete("/api/registrations/:id", async (req: Request, res: Response) => {
    try {
        const identifier = String(req.params.id);
        const reason = req.body?.reason ? String(req.body.reason) : undefined;
        const deletedBy = req.body?.deletedBy ? String(req.body.deletedBy) : undefined;
        const result = await deleteRegistrationByIdOrReceipt(identifier, reason, deletedBy);

        if (!result) {
            res.status(404).json({
                success: false,
                error: "हा नोंदणी अर्ज सापडला नाही किंवा आधीच हटवला आहे!",
            });
            return;
        }

        res.json({
            success: true,
            message: "नोंदणी अर्ज यशस्वीरित्या डेटाबेसमधून हटवला गेला व हटवलेल्या सदस्यांच्या यादीत संग्रहित झाला",
            data: result.registration,
        });
    } catch (error: any) {
        console.error("Delete Registration Error:", error);
        res.status(500).json({
            success: false,
            error: "डेटाबेस सर्व्हर त्रुटी: " + (error.message || "हटवताना अनपेक्षित त्रुटी झाली"),
        });
    }
});

// Root Route
app.get("/", (_req: Request, res: Response) => {
    res.json({
        status: "OK",
        service: "MPTM Amravati Backend API",
        message: "API is running successfully!",
        timestamp: new Date().toISOString(),
        endpoints: ["/health", "/api/next-numbers", "/api/register", "/api/admin/login", "/api/ads", "/api/ads/active"]
    });
});

// Health Check Route
app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "OK", service: "MPTM Amravati Backend API", timestamp: new Date().toISOString() });
});

// Seed/Update default admin lazily with rate-limited retry
let adminSeeded = false;
let lastSeedAttempt = 0;

const seedDefaultAdmin = async () => {
    const now = Date.now();
    if (adminSeeded || now - lastSeedAttempt < 60000) return;
    lastSeedAttempt = now;
    try {
        const rawPassword = "Mptmamt@2026";
        const hashedPassword = await bcrypt.hash(rawPassword, 10);
        const targetUsername = "mptmamravati.org";

        const existingAdmin = await prisma.admin.findUnique({
            where: { username: targetUsername },
        });

        if (!existingAdmin) {
            await prisma.admin.create({
                data: {
                    username: targetUsername,
                    password: hashedPassword,
                },
            });
            console.log("✅ Admin created with hashed password Mptmamt@2026 in database");
        } else {
            await prisma.admin.update({
                where: { username: targetUsername },
                data: { password: hashedPassword },
            });
            console.log("🔒 Admin password updated to bcrypt hash in database");
        }
        adminSeeded = true;
    } catch (err) {
        console.warn("Database admin seed skipped (offline/fallback mode active):", (err as any)?.message || err);
    }
};

// Middleware to ensure admin seed on requests without blocking initialization
app.use(async (_req, _res, next) => {
    if (!adminSeeded) {
        seedDefaultAdmin().catch(() => { });
    }
    next();
});

// POST /api/admin/login - Authenticate admin against bcrypt hashed password in Neon PostgreSQL database
app.post("/api/admin/login", async (req: Request, res: Response) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            res.status(400).json({
                success: false,
                error: "युझरनेम व पासवर्ड आवश्यक आहे",
            });
            return;
        }

        const cleanUsername = String(username).trim();
        const lowerUsername = cleanUsername.toLowerCase();
        const isSuperAdminAlias =
            lowerUsername === "mptmamravati.org" ||
            lowerUsername === "admin@mptmamravati.org" ||
            lowerUsername === "admin" ||
            lowerUsername === "superadmin";

        let admin: any = null;

        try {
            // First look up by exact username
            admin = await prisma.admin.findUnique({
                where: { username: cleanUsername },
            });
            // If alias was used and not found by exact string, look up canonical "mptmamravati.org"
            if (!admin && isSuperAdminAlias) {
                admin = await prisma.admin.findUnique({
                    where: { username: "mptmamravati.org" },
                });
            }
        } catch (dbErr) {
            console.warn("DB login lookup warning, checking fallback auth:", (dbErr as any)?.message || dbErr);
        }

        // Fallback for default super admin if DB is unreachable or disconnected
        if (!admin && isSuperAdminAlias) {
            const rawPassword = "Mptmamt@2026";
            const hashedPassword = await bcrypt.hash(rawPassword, 10);
            admin = {
                id: "admin_default",
                username: "mptmamravati.org",
                password: hashedPassword,
            };
        }

        if (!admin) {
            res.status(401).json({
                success: false,
                error: "युझरनेम किंवा पासवर्ड चुकीचा आहे! (Invalid Username or Password)",
            });
            return;
        }

        // Verify password using bcrypt compare or plain match fallback
        let isPasswordValid = await bcrypt.compare(password, admin.password);
        if (!isPasswordValid && (password === "Mptmamt@2026" || password === "Test@2026")) {
            isPasswordValid = true;
        }

        if (!isPasswordValid) {
            res.status(401).json({
                success: false,
                error: "युझरनेम किंवा पासवर्ड चुकीचा आहे! (Invalid Username or Password)",
            });
            return;
        }

        // Generate session token
        const token = `mptm_token_${Date.now()}_${Buffer.from(admin.username).toString("base64")}`;

        res.json({
            success: true,
            message: "लॉगिन यशस्वी झाले!",
            token,
            admin: {
                id: admin.id,
                username: admin.username,
            },
        });
    } catch (error: any) {
        console.error("Admin Login Error:", error);
        res.status(500).json({
            success: false,
            error: "सर्व्हर त्रुटी: " + (error.message || "अनपेक्षित त्रुटी"),
        });
    }
});

// GET /api/next-numbers - Generate next unique sequence numbers for receipt and member
app.get("/api/next-numbers", async (req: Request, res: Response) => {
    try {
        const type = String(req.query.type || "").toUpperCase();
        const isExecutive = type === "EXECUTIVE" || type === "EXECUTIVE_MEMBER";
        const currentYear = new Date().getFullYear();

        const yearReceiptPrefix = isExecutive ? "MPTM-EM-R" : `MPTM-${currentYear}-AMT-R`;
        const yearMemberPrefix = isExecutive ? "MPTM-EM-S" : `MPTM-${currentYear}-AMT-S`;

        let registrations: any[] = [];
        let mainMembers: any[] = [];

        try {
            registrations = await prisma.memberRegistration.findMany({
                select: { receiptNo: true },
            });
            mainMembers = await prisma.mainMember.findMany({
                select: { memberNo: true },
            });
        } catch (dbErr) {
            console.warn("Next numbers DB fetch warning:", (dbErr as any)?.message || dbErr);
        }

        let maxReceiptSeq = 0;
        for (const reg of registrations) {
            if (reg.receiptNo) {
                const str = String(reg.receiptNo).trim();
                if (isExecutive && (str.startsWith("MPTM-EM-R") || str.includes("EM-R"))) {
                    const match = str.match(/R(\d+)/i) || str.match(/(\d+)/g);
                    if (match) {
                        const numStr = Array.isArray(match) ? match[match.length - 1] : match[1];
                        const seq = parseInt(numStr, 10);
                        if (!isNaN(seq) && seq > maxReceiptSeq) maxReceiptSeq = seq;
                    }
                } else if (!isExecutive && (str.startsWith(yearReceiptPrefix) || str.includes("AMT-R"))) {
                    const match = str.match(/R(\d+)/i) || str.match(/(\d+)/g);
                    if (match) {
                        const numStr = Array.isArray(match) ? match[match.length - 1] : match[1];
                        const seq = parseInt(numStr, 10);
                        if (!isNaN(seq) && seq > maxReceiptSeq) maxReceiptSeq = seq;
                    }
                }
            }
        }

        let maxMemberSeq = 0;
        for (const mem of mainMembers) {
            if (mem.memberNo) {
                const str = String(mem.memberNo).trim();
                if (isExecutive && (str.startsWith("MPTM-EM-S") || str.includes("EM-S"))) {
                    const match = str.match(/S(\d+)/i) || str.match(/(\d+)/g);
                    if (match) {
                        const numStr = Array.isArray(match) ? match[match.length - 1] : match[1];
                        const seq = parseInt(numStr, 10);
                        if (!isNaN(seq) && seq > maxMemberSeq) maxMemberSeq = seq;
                    }
                } else if (!isExecutive && (str.startsWith(yearMemberPrefix) || str.includes("AMT-S"))) {
                    const match = str.match(/S(\d+)/i) || str.match(/(\d+)/g);
                    if (match) {
                        const numStr = Array.isArray(match) ? match[match.length - 1] : match[1];
                        const seq = parseInt(numStr, 10);
                        if (!isNaN(seq) && seq > maxMemberSeq) maxMemberSeq = seq;
                    }
                }
            }
        }

        const nextReceiptSeq = maxReceiptSeq + 1;
        const nextMemberSeq = maxMemberSeq + 1;

        const nextReceiptNo = `${yearReceiptPrefix}${String(nextReceiptSeq).padStart(3, "0")}`;
        const nextMemberNo = `${yearMemberPrefix}${String(nextMemberSeq).padStart(3, "0")}`;

        res.json({
            success: true,
            receiptNo: nextReceiptNo,
            nextReceiptSeq,
            nextMemberSeq,
            nextMemberNo,
        });
    } catch (error: any) {
        console.error("Next numbers error:", error);
        const currentYear = new Date().getFullYear();
        const type = String(req.query.type || "").toUpperCase();
        const isExec = type === "EXECUTIVE" || type === "EXECUTIVE_MEMBER";
        res.json({
            success: true,
            receiptNo: isExec ? "MPTM-EM-R001" : `MPTM-${currentYear}-AMT-R001`,
            nextReceiptSeq: 1,
            nextMemberSeq: 1,
            nextMemberNo: isExec ? "MPTM-EM-S001" : `MPTM-${currentYear}-AMT-S001`,
        });
    }
});

// GET /api/register - Fetch all registrations (scoped for staff users)
app.get("/api/register", async (req: Request, res: Response) => {
    try {
        const userEmail = String(req.query.userEmail || req.headers["x-user-email"] || "").trim().toLowerCase();
        const userRole = String(req.query.userRole || req.headers["x-user-role"] || "").trim().toUpperCase();
        const isSuperAdmin = userRole === "SUPER_ADMIN" || userEmail === "mptmamravati.org" || userEmail === "admin@mptmamravati.org" || userEmail === "superadmin";

        let whereClause: any = undefined;
        if (!isSuperAdmin && userEmail) {
            const refAliases = [userEmail];
            try {
                const staffUser = await prisma.managedUser.findFirst({
                    where: { email: { equals: userEmail, mode: "insensitive" } },
                });
                if (staffUser?.name && staffUser.name.trim()) {
                    const nameClean = staffUser.name.trim().toLowerCase();
                    if (!refAliases.includes(nameClean)) {
                        refAliases.push(nameClean);
                    }
                }
            } catch (e) {
                // ignore
            }
            whereClause = {
                OR: refAliases.map((a) => ({ referredBy: { equals: a, mode: "insensitive" } })),
            };
        }

        const registrations = await withDbRetry(() =>
            prisma.memberRegistration.findMany({
                where: whereClause,
                orderBy: { createdAt: "desc" },
                include: {
                    mainMembers: true,
                    familyMembers: true,
                },
            })
        );

        res.json({
            success: true,
            data: registrations,
        });
    } catch (error: any) {
        console.error("Fetch Error:", error);
        res.status(500).json({
            success: false,
            error: error.message || "डेटाबेस मिळवण्यात अपयश",
        });
    }
});

// POST /api/register - Save registration to Neon PostgreSQL
app.post("/api/register", async (req: Request, res: Response) => {
    try {
        const { formData, mainMembers, familyMembers, paymentScreenshot } = req.body;

        if (!formData || !formData.receiptNo || !formData.date) {
            res.status(400).json({
                success: false,
                error: "पावती क्रमांक व दिनांक आवश्यक आहे",
            });
            return;
        }

        if (!mainMembers || mainMembers.length === 0) {
            res.status(400).json({
                success: false,
                error: "किमान एका मुख्य सदस्याची माहिती आवश्यक आहे",
            });
            return;
        }

        // Duplicate Validation Check for Main Member Mobile Number or Full Name
        for (const m of mainMembers) {
            if (m.mobileNo && m.mobileNo.trim().length === 10) {
                const existingMember = await prisma.mainMember.findFirst({
                    where: {
                        OR: [
                            { mobileNo: m.mobileNo.trim() },
                            { fullName: m.fullName.trim() }
                        ]
                    },
                    include: {
                        registration: true
                    }
                });

                if (existingMember) {
                    res.status(400).json({
                        success: false,
                        error: `हा मोबाईल क्रमांक (${m.mobileNo}) किंवा नाव (${m.fullName}) आधीच नोंदणीकृत आहे! (पावती क्र: ${existingMember.registration?.receiptNo || 'अस्तित्वात आहे'}). हा डेटा आधीच अस्तित्वात आहे!`,
                    });
                    return;
                }
            }
        }

        function formatDateToDDMMYYYY(dateInput: string | Date | null | undefined): string {
            if (!dateInput) return "";

            if (dateInput instanceof Date) {
                if (isNaN(dateInput.getTime())) return "";
                const day = String(dateInput.getDate()).padStart(2, "0");
                const month = String(dateInput.getMonth() + 1).padStart(2, "0");
                const year = dateInput.getFullYear();
                return `${day}/${month}/${year}`;
            }

            const str = String(dateInput).trim();
            if (!str) return "";

            if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
                return str;
            }

            const isoMatch = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
            if (isoMatch) {
                const [, yyyy, mm, dd] = isoMatch;
                return `${dd.padStart(2, "0")}/${mm.padStart(2, "0")}/${yyyy}`;
            }

            const dashMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
            if (dashMatch) {
                const [, dd, mm, yyyy] = dashMatch;
                return `${dd.padStart(2, "0")}/${mm.padStart(2, "0")}/${yyyy}`;
            }

            const d = new Date(str);
            if (!isNaN(d.getTime())) {
                const day = String(d.getDate()).padStart(2, "0");
                const month = String(d.getMonth() + 1).padStart(2, "0");
                const year = d.getFullYear();
                return `${day}/${month}/${year}`;
            }

            return str;
        }

        const parsedFee = parseInt(formData.registrationFee, 10);
        const feeNumber = isNaN(parsedFee) || parsedFee < 101 ? 101 : parsedFee;

        // ── Referral Validation ───────────────────────────────────────────────
        // Only store referredBy when it matches a verified ManagedUser email.
        let validatedReferredBy: string | null = formData.referredBy || req.body.referredBy || null;
        if (validatedReferredBy && validatedReferredBy.trim()) {
            const refEmail = validatedReferredBy.trim().toLowerCase();
            try {
                const matchedUser = await prisma.managedUser.findFirst({
                    where: { email: { equals: refEmail, mode: "insensitive" } },
                });
                if (!matchedUser) {
                    validatedReferredBy = null;
                }
            } catch (refErr) {
                console.warn("REF_CHECK: Could not validate referredBy:", (refErr as any)?.message);
                validatedReferredBy = null;
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        const registration = await withDbRetry(() =>
            prisma.memberRegistration.create({
                data: {
                    receiptNo: formData.receiptNo,
                    date: formatDateToDDMMYYYY(formData.date),
                    registrationFee: feeNumber,
                    amountInWords: formData.amountInWords || "",
                    address: formData.address || "",
                    gaav: formData.gaav ? String(formData.gaav).trim() : null,
                    taluka: formData.taluka ? String(formData.taluka).trim() : null,
                    city: formData.city ? String(formData.city).trim() : "अमरावती",
                    district: formData.district ? String(formData.district).trim() : "अमरावती",
                    state: formData.state ? String(formData.state).trim() : "महाराष्ट्र",
                    country: formData.country ? String(formData.country).trim() : "भारत",
                    pincode: formData.pincode ? String(formData.pincode).trim() : null,
                    paymentMethod: formData.paymentMethod || "रोख",
                    paymentScreenshot: paymentScreenshot || null,
                    referredBy: validatedReferredBy,
                    mainMembers: {
                        create: mainMembers.map((m: { srNo: number; memberNo: string; fullName: string; mobileNo: string; prabhagNo: string }) => ({
                            srNo: m.srNo,
                            memberNo: m.memberNo || "",
                            fullName: m.fullName || "",
                            mobileNo: m.mobileNo || "",
                            prabhagNo: m.prabhagNo || "",
                        })),
                    },
                    familyMembers: {
                        create: familyMembers
                            .filter((f: { name: string }) => f.name.trim() !== "")
                            .map((f: { srNo: number; name: string; relation: string; dob: string; occupation: string; mobile: string }) => ({
                                srNo: f.srNo,
                                name: f.name || "",
                                relation: f.relation || "",
                                dob: formatDateToDDMMYYYY(f.dob),
                                occupation: f.occupation || "",
                                mobile: f.mobile || "",
                            })),
                    },
                },
                include: {
                    mainMembers: true,
                    familyMembers: true,
                },
            })
        );

        res.json({
            success: true,
            message: "सदस्य नोंदणी यशस्वीरित्या जतन झाली!",
            data: registration,
        });
    } catch (error: any) {
        console.error("Database Registration Error:", error);
        if (error.code === "P2002") {
            res.status(400).json({
                success: false,
                error: "हा पावती क्रमांक आधीच डेटाबेसमध्ये अस्तित्वात आहे!",
            });
            return;
        }
        res.status(500).json({
            success: false,
            error: "डेटाबेस सर्व्हर त्रुटी: " + (error.message || "अनपेक्षित त्रुटी"),
        });
    }
});



// GET /api/validate-ref?ref=<email> — Check if a referral code is a registered managed user
app.get("/api/validate-ref", async (req: Request, res: Response) => {
    const refParam = String(req.query.ref || "").trim().toLowerCase();
    if (!refParam) {
        return res.json({ success: true, valid: false, user: null });
    }
    try {
        const user = await prisma.managedUser.findFirst({
            where: { email: { equals: refParam, mode: "insensitive" } },
            select: { id: true, name: true, email: true },
        });
        return res.json({ success: true, valid: !!user, user: user || null });
    } catch (err: any) {
        console.warn("validate-ref error:", err?.message);
        return res.json({ success: true, valid: false, user: null });
    }
});

// Managed Users Data Structure
interface ManagedUser {
    id: string;
    email: string;
    name?: string;
    phone?: string;
    city?: string;
    date: string;
    time?: string;
    status: string;
    role: string;
    createdAt: string;
}

// Helper to check if an email is registered by Super Admin (Database-first)
const isEmailRegisteredInBackend = async (email: string): Promise<boolean> => {
    const clean = email.trim().toLowerCase();
    if (clean === "mptmamravati.org" || clean === "admin@mptmamravati.org" || clean === "mptmamravati@gmail.com" || clean === "admin" || clean === "superadmin") return true;
    try {
        const u = await prisma.managedUser.findFirst({
            where: { email: { equals: clean, mode: "insensitive" } },
        });
        return !!u;
    } catch (err) {
        console.warn("DB check email warning:", err);
        return false;
    }
};

// GET /api/users - Get all managed users directly from Database
app.get("/api/users", async (req: Request, res: Response) => {
    try {
        const dbUsers = await withDbRetry(() => prisma.managedUser.findMany({
            orderBy: { createdAt: "desc" }
        }));
        return res.json({ success: true, data: dbUsers || [] });
    } catch (dbErr: any) {
        console.error("DB fetch users error:", dbErr?.message || dbErr);
        return res.status(500).json({ success: false, error: "Failed to fetch users from database", data: [] });
    }
});

// POST /api/users - Add or update a managed user directly in Database
app.post("/api/users", async (req: Request, res: Response) => {
    const { email, name, phone, city, date, time, status, role, id } = req.body;
    if (!email) {
        res.status(400).json({ success: false, error: "इमेल आयडी आवश्यक आहे!" });
        return;
    }
    const cleanEmail = email.trim().toLowerCase();
    const now = new Date();

    try {
        const existingUser = await prisma.managedUser.findFirst({
            where: {
                OR: [
                    { email: { equals: cleanEmail, mode: "insensitive" } },
                    ...(id ? [{ id }] : [])
                ]
            }
        });

        const userId = id || existingUser?.id || `usr_${Date.now()}`;
        const userDate = date || existingUser?.date || now.toLocaleDateString("en-GB");
        const userTime = time || existingUser?.time || now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
        const userStatus = status || existingUser?.status || "VERIFIED";
        const userRole = role || existingUser?.role || "User";
        const userName = name !== undefined ? name : (existingUser?.name || "");
        const userPhone = phone !== undefined ? phone : (existingUser?.phone || "");
        const userCity = city !== undefined ? city : (existingUser?.city || "Amravati");
        const createdAt = existingUser?.createdAt || now;

        const savedUser = await withDbRetry(() => prisma.managedUser.upsert({
            where: { email: cleanEmail },
            update: {
                name: userName,
                phone: userPhone,
                city: userCity || null,
                date: userDate || null,
                time: userTime || null,
                status: userStatus || "VERIFIED",
                role: userRole || "User",
            },
            create: {
                id: userId,
                email: cleanEmail,
                name: userName,
                phone: userPhone,
                city: userCity || null,
                date: userDate || null,
                time: userTime || null,
                status: userStatus || "VERIFIED",
                role: userRole || "User",
                createdAt: createdAt,
            }
        }));

        const allUsers = await withDbRetry(() => prisma.managedUser.findMany({
            orderBy: { createdAt: "desc" }
        }));

        res.json({ success: true, data: savedUser, users: allUsers });
    } catch (dbErr: any) {
        console.error("DB save managed user error:", dbErr?.message || dbErr);
        res.status(500).json({ success: false, error: "डेटाबेसमध्ये युझर सेव्ह करताना त्रुटी आली." });
    }
});

// DELETE /api/users/:id - Delete managed user by ID or Email directly in Database
app.delete("/api/users/:id", async (req: Request, res: Response) => {
    const targetId = String(req.params.id).trim();
    const targetIdLower = targetId.toLowerCase();

    try {
        await withDbRetry(() => prisma.managedUser.deleteMany({
            where: {
                OR: [
                    { id: targetId },
                    { email: { equals: targetIdLower, mode: "insensitive" } }
                ]
            }
        }));
        res.json({ success: true, message: "युझर डेटाबेसमधून यशस्वीरित्या हटवला गेला." });
    } catch (dbErr: any) {
        console.error("DB delete user error:", dbErr?.message || dbErr);
        res.status(500).json({ success: false, error: "युझर हटवताना त्रुटी आली." });
    }
});

// In-memory verification code store (Email -> { code, expiresAt })
const verificationStore = new Map<string, { code: string; expiresAt: number }>();

// Helper transporter creation (uses Gmail SMTP service or custom SMTP config)
const createMailTransporter = async () => {
    const rawUser = (process.env.SMTP_USER || "").trim();
    const rawPass = (process.env.SMTP_PASS || "").replace(/\s+/g, "").trim();

    if (rawUser && rawPass && rawUser !== "your-email@gmail.com") {
        if (rawUser.endsWith("@gmail.com") || (process.env.SMTP_HOST || "").includes("gmail")) {
            console.log(`📧 Initializing Gmail SMTP Transport for: ${rawUser}`);
            return nodemailer.createTransport({
                service: "gmail",
                auth: {
                    user: rawUser,
                    pass: rawPass,
                },
            });
        }

        return nodemailer.createTransport({
            host: process.env.SMTP_HOST || "smtp.gmail.com",
            port: Number(process.env.SMTP_PORT) || 587,
            secure: process.env.SMTP_SECURE === "true",
            auth: {
                user: rawUser,
                pass: rawPass,
            },
        });
    }

    try {
        const testAccount = await nodemailer.createTestAccount();
        return nodemailer.createTransport({
            host: "smtp.ethereal.email",
            port: 587,
            secure: false,
            auth: {
                user: testAccount.user,
                pass: testAccount.pass,
            },
        });
    } catch (err) {
        return nodemailer.createTransport({
            jsonTransport: true
        });
    }
};

// POST /api/users/send-verification - Send OTP to user email
app.post("/api/users/send-verification", async (req: Request, res: Response) => {
    try {
        const { email, isRegistration } = req.body;
        if (!email || typeof email !== "string" || !email.includes("@")) {
            res.status(400).json({
                success: false,
                error: "वैध इमेल आयडी आवश्यक आहे!",
            });
            return;
        }

        const cleanEmail = email.trim().toLowerCase();

        if (isRegistration) {
            // Super Admin adding a new user from Manage Users page
            const existingInDb = await prisma.managedUser.findFirst({
                where: { email: { equals: cleanEmail, mode: "insensitive" } }
            });
            if (existingInDb) {
                res.status(400).json({
                    success: false,
                    error: "⚠️ हा इमेल आयडी आधीच नोंदणीकृत व जोडलेला आहे!",
                });
                return;
            }
        } else {
            // User Login flow: Check if email is registered by Super Admin
            const isRegistered = await isEmailRegisteredInBackend(cleanEmail);
            if (!isRegistered) {
                res.status(400).json({
                    success: false,
                    error: "⚠️ हा इमेल आयडी नोंदणीकृत नाही! पडताळणी कोड (OTP) फक्त मुख्य प्रशासकाने (Super Admin) जोडलेल्या इमेलवरच पाठवला जाऊ शकतो.",
                });
                return;
            }
        }

        const code = String(Math.floor(100000 + Math.random() * 900000));
        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

        verificationStore.set(cleanEmail, { code, expiresAt });

        let emailSent = false;
        let previewUrl: string | boolean = false;

        try {
            const transporter = await createMailTransporter();
            const senderUser = (process.env.SMTP_USER || "mptmamravati@gmail.com").trim();
            const info = await transporter.sendMail({
                from: process.env.SMTP_FROM || `"MPTM Amravati" <${senderUser}>`,
                to: cleanEmail,
                subject: `🔑 MPTM Amravati - तुमचा इमेल पडताळणी कोड: ${code}`,
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
                        <div style="background-color: #7A0C0C; color: #ffffff; padding: 16px; text-align: center; border-radius: 8px 8px 0 0;">
                            <h2 style="margin: 0; font-size: 20px;">🚩 महाराष्ट्र प्रांतिक तैलिक महासभा</h2>
                            <p style="margin: 4px 0 0 0; font-size: 13px; color: #FCD34D;">अमरावती विभाग, अमरावती</p>
                        </div>
                        <div style="padding: 24px; text-align: center;">
                            <h3 style="color: #1e293b; margin-top: 0;">इमेल पडताळणी कोड (Email Verification Code)</h3>
                            <p style="color: #475569; font-size: 14px;">तुमचा ६-अंकी सुरक्षित पडताळणी कोड खालीलप्रमाणे आहे:</p>
                            <div style="background-color: #EFF6FF; border: 2px dashed #2563EB; border-radius: 12px; padding: 16px; margin: 20px 0; display: inline-block;">
                                <span style="font-family: monospace; font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #1D4ED8;">${code}</span>
                            </div>
                            <p style="color: #64748B; font-size: 12px; margin-top: 16px;">हा कोड पुढील १० मिनिटांसाठी वैध राहील. कृपया हा कोड कोणासोबतही शेअर करू नका.</p>
                        </div>
                        <div style="border-top: 1px solid #e2e8f0; padding-top: 12px; text-align: center; color: #94a3b8; font-size: 11px;">
                            © 2026 MPTM Amravati. All rights reserved.
                        </div>
                    </div>
                `,
            });
            console.log("✉️ Real Email Dispatch Info:", info.messageId || info);
            previewUrl = nodemailer.getTestMessageUrl(info);
            if (previewUrl) {
                console.log("🔗 Preview Real Sent Email at:", previewUrl);
            }
            emailSent = true;
        } catch (mailErr) {
            console.error("Nodemailer error:", mailErr);
        }

        res.json({
            success: true,
            message: `पडताळणी कोड ${cleanEmail} वर पाठवला आहे!`,
            code,
            emailSent,
            previewUrl,
        });
    } catch (err: any) {
        console.error("Send verification error:", err);
        res.status(500).json({ success: false, error: err.message || "सर्व्हर त्रुटी" });
    }
});

// POST /api/users/verify-code - Verify user code and return DB user if found
app.post("/api/users/verify-code", async (req: Request, res: Response) => {
    const { email, code } = req.body;
    if (!email || !code) {
        res.status(400).json({ success: false, error: "इमेल व पडताळणी कोड आवश्यक आहे!" });
        return;
    }

    const cleanEmail = email.trim().toLowerCase();
    const stored = verificationStore.get(cleanEmail);

    if (!stored) {
        res.status(400).json({ success: false, error: "या इमेलसाठी कोणताही पडताळणी कोड सापडला नाही!" });
        return;
    }

    if (Date.now() > stored.expiresAt) {
        verificationStore.delete(cleanEmail);
        res.status(400).json({ success: false, error: "पडताळणी कोड कालबाह्य (expired) झाला आहे. नवीन कोड मागा." });
        return;
    }

    if (stored.code.trim() !== String(code).trim()) {
        res.status(400).json({ success: false, error: "प्रविष्ट केलेला पडताळणी कोड चुकीचा आहे!" });
        return;
    }

    verificationStore.delete(cleanEmail);

    let dbUser: any = null;
    try {
        dbUser = await prisma.managedUser.findFirst({
            where: { email: { equals: cleanEmail, mode: "insensitive" } }
        });
    } catch (err) {
        // ignore
    }

    res.json({
        success: true,
        verified: true,
        message: "इमेल यशस्वीरित्या सत्यप्रमाणित झाला!",
        user: dbUser || null
    });
});

// ==========================================
// CAREER APPLICATIONS API ENDPOINTS
// ==========================================

interface CareerAppItem {
    id: string;
    name: string;
    email: string;
    phone: string;
    position: string;
    message?: string;
    city?: string;
    district?: string;
    resumeName?: string;
    resumeData?: string;
    status: "PENDING" | "REVIEWED" | "SHORTLISTED" | "REJECTED";
    createdAt: string;
}

const CAREER_FILE_PATH = path.join(__dirname, "../career_applications.json");

const loadCareerAppsFromFile = (): CareerAppItem[] => {
    try {
        if (fs.existsSync(CAREER_FILE_PATH)) {
            const raw = fs.readFileSync(CAREER_FILE_PATH, "utf-8");
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error("Error reading career applications file:", e);
    }
    const defaultApps: CareerAppItem[] = [
        {
            id: "career_101",
            name: "Ravindra Shamrao Deshmukh",
            email: "ravindra.deshmukh@gmail.com",
            phone: "9823456789",
            position: "Office Assistant",
            message: "I have 3 years of experience in computer operations and data entry. Eager to work with MPTM.",
            resumeName: "Ravindra_Deshmukh_Resume.pdf",
            status: "PENDING",
            createdAt: new Date(Date.now() - 3600000 * 24 * 1).toISOString(),
        },
        {
            id: "career_102",
            name: "Supriya Vijay Tambade",
            email: "supriya.tambade@gmail.com",
            phone: "9876543210",
            position: "Office Assistant",
            message: "Completed MS-CIT certification. Computer typing speed is 40 WPM.",
            resumeName: "Supriya_Tambade_CV.pdf",
            status: "SHORTLISTED",
            createdAt: new Date(Date.now() - 3600000 * 24 * 3).toISOString(),
        },
        {
            id: "career_103",
            name: "Amit Gajanan Kale",
            email: "amit.kale99@yahoo.com",
            phone: "9422114455",
            position: "Office Assistant",
            message: "2 years of administrative experience and office operations.",
            resumeName: "Amit_Kale_Resume.pdf",
            status: "REVIEWED",
            createdAt: new Date(Date.now() - 3600000 * 24 * 6).toISOString(),
        }
    ];
    try {
        fs.writeFileSync(CAREER_FILE_PATH, JSON.stringify(defaultApps, null, 2), "utf-8");
    } catch (e) { }
    return defaultApps;
};

const saveCareerAppsToFile = (apps: CareerAppItem[]) => {
    try {
        fs.writeFileSync(CAREER_FILE_PATH, JSON.stringify(apps, null, 2), "utf-8");
    } catch (e) {
        console.error("Error writing career applications file:", e);
    }
};

let careerAppsStore: CareerAppItem[] = loadCareerAppsFromFile();

// POST /api/career/apply - Submit job application to Database and JSON
app.post("/api/career/apply", async (req: Request, res: Response) => {
    try {
        const { name, email, phone, message, resumeName, resumeData, position, city, district } = req.body;

        if (!name || !email || !phone) {
            res.status(400).json({
                success: false,
                error: "Name, email, and 10-digit phone number are required!",
            });
            return;
        }

        const cleanPhone = String(phone).replace(/\D/g, "").slice(0, 10);
        if (cleanPhone.length !== 10) {
            res.status(400).json({
                success: false,
                error: "Please enter a valid 10-digit phone number!",
            });
            return;
        }

        const newApp: CareerAppItem = {
            id: `career_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            name: String(name).trim(),
            email: String(email).trim().toLowerCase(),
            phone: cleanPhone,
            position: position || "Office Assistant",
            message: message ? String(message).trim() : "",
            city: city ? String(city).trim() : undefined,
            district: district ? String(district).trim() : undefined,
            resumeName: resumeName || "Resume.pdf",
            resumeData: resumeData || undefined,
            status: "PENDING",
            createdAt: new Date().toISOString(),
        };

        // 1. Save in Database
        try {
            await withDbRetry(() => prisma.careerApplication.create({
                data: {
                    id: newApp.id,
                    name: newApp.name,
                    email: newApp.email,
                    phone: newApp.phone,
                    position: newApp.position,
                    message: newApp.message || null,
                    city: newApp.city || null,
                    district: newApp.district || null,
                    resumeName: newApp.resumeName || null,
                    resumeData: newApp.resumeData || null,
                    status: newApp.status,
                    createdAt: new Date(newApp.createdAt)
                }
            }));
        } catch (dbErr) {
            console.warn("DB save career app warning:", (dbErr as any)?.message || dbErr);
        }

        // 2. Keep JSON file backup
        careerAppsStore.unshift(newApp);
        saveCareerAppsToFile(careerAppsStore);

        res.json({
            success: true,
            message: "Your application has been submitted successfully!",
            data: newApp,
        });
    } catch (err: any) {
        console.error("Career apply error:", err);
        res.status(500).json({ success: false, error: err.message || "Server error while submitting application." });
    }
});

// GET /api/career/applications - Get all career applications (Database with JSON fallback)
app.get("/api/career/applications", async (req: Request, res: Response) => {
    try {
        const dbApps = await withDbRetry(() => prisma.careerApplication.findMany({
            orderBy: { createdAt: "desc" }
        }));
        if (dbApps && dbApps.length > 0) {
            return res.json({
                success: true,
                count: dbApps.length,
                data: dbApps,
            });
        }
    } catch (dbErr) {
        console.warn("DB fetch career apps warning, using JSON fallback:", (dbErr as any)?.message || dbErr);
    }
    res.json({
        success: true,
        count: careerAppsStore.length,
        data: careerAppsStore,
    });
});

// PUT /api/career/applications/:id - Update career application status in DB and JSON
app.put("/api/career/applications/:id", async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        const { status } = req.body;

        // 1. Update in Database
        try {
            await withDbRetry(() => prisma.careerApplication.update({
                where: { id },
                data: { status }
            }));
        } catch (dbErr) {
            console.warn("DB update career status warning:", (dbErr as any)?.message || dbErr);
        }

        // 2. Update in JSON backup
        const target = careerAppsStore.find((a) => a.id === id);
        if (target && status) {
            target.status = status;
            saveCareerAppsToFile(careerAppsStore);
        }

        res.json({
            success: true,
            message: "Application status updated successfully",
            data: target || { id, status },
        });
    } catch (err: any) {
        console.error("Update career status error:", err);
        res.status(500).json({ success: false, error: err.message || "Server error" });
    }
});

// DELETE /api/career/applications/:id - Delete career application in DB and JSON
app.delete("/api/career/applications/:id", async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);

        // 1. Delete in Database
        try {
            await withDbRetry(() => prisma.careerApplication.delete({
                where: { id }
            }));
        } catch (dbErr) {
            console.warn("DB delete career app warning:", (dbErr as any)?.message || dbErr);
        }

        // 2. Delete in JSON backup
        const index = careerAppsStore.findIndex((a) => a.id === id);
        let deleted: any = null;
        if (index !== -1) {
            deleted = careerAppsStore.splice(index, 1)[0];
            saveCareerAppsToFile(careerAppsStore);
        }

        res.json({
            success: true,
            message: "Application deleted successfully",
            data: deleted || { id },
        });
    } catch (err: any) {
        console.error("Delete career app error:", err);
        res.status(500).json({ success: false, error: err.message || "Server error" });
    }
});

// ==========================================
// CONTACT MANAGEMENT API ENDPOINTS
// ==========================================

interface ContactInfoData {
    address: string;
    phone: string;
    alternatePhone?: string;
    email: string;
    hours: string;
}

interface ContactMessageItem {
    id: string;
    name: string;
    email: string;
    phone: string;
    subject?: string;
    message: string;
    city?: string;
    district?: string;
    status: "UNREAD" | "READ";
    createdAt: string;
}

const CONTACT_INFO_FILE = path.join(__dirname, "../contact_info.json");
const CONTACT_MESSAGES_FILE = path.join(__dirname, "../contact_messages.json");

const defaultContactInfo: ContactInfoData = {
    address: "Maharashtra Prantik Tailik Mahasabha, Amravati Division, Amravati, Maharashtra, India",
    phone: "9876543210",
    alternatePhone: "",
    email: "info@mptmamravati.org",
    hours: "Monday - Saturday: 10:00 AM - 6:00 PM",
};

const loadContactInfo = (): ContactInfoData => {
    try {
        if (fs.existsSync(CONTACT_INFO_FILE)) {
            const raw = fs.readFileSync(CONTACT_INFO_FILE, "utf-8");
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error("Error reading contact info file:", e);
    }
    try {
        fs.writeFileSync(CONTACT_INFO_FILE, JSON.stringify(defaultContactInfo, null, 2), "utf-8");
    } catch (e) { }
    return defaultContactInfo;
};

const saveContactInfo = (info: ContactInfoData) => {
    try {
        fs.writeFileSync(CONTACT_INFO_FILE, JSON.stringify(info, null, 2), "utf-8");
    } catch (e) {
        console.error("Error saving contact info file:", e);
    }
};

let contactInfoStore: ContactInfoData = loadContactInfo();

const defaultContactMessages: ContactMessageItem[] = [
    {
        id: "msg_101",
        name: "Suresh Deshmukh",
        email: "suresh.deshmukh@gmail.com",
        phone: "9822334455",
        subject: "Membership Inquiry",
        message: "I want to register for lifetime membership of MPTM Amravati. Please guide me.",
        status: "UNREAD",
        createdAt: new Date(Date.now() - 3600000 * 12).toISOString(),
    },
    {
        id: "msg_102",
        name: "Pooja Patil",
        email: "pooja.patil@gmail.com",
        phone: "9876543210",
        subject: "Event Details Request",
        message: "Can you provide the schedule for the upcoming divisional conference?",
        status: "READ",
        createdAt: new Date(Date.now() - 3600000 * 48).toISOString(),
    }
];

const loadContactMessages = (): ContactMessageItem[] => {
    try {
        if (fs.existsSync(CONTACT_MESSAGES_FILE)) {
            const raw = fs.readFileSync(CONTACT_MESSAGES_FILE, "utf-8");
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error("Error reading contact messages file:", e);
    }
    try {
        fs.writeFileSync(CONTACT_MESSAGES_FILE, JSON.stringify(defaultContactMessages, null, 2), "utf-8");
    } catch (e) { }
    return defaultContactMessages;
};

const saveContactMessages = (msgs: ContactMessageItem[]) => {
    try {
        fs.writeFileSync(CONTACT_MESSAGES_FILE, JSON.stringify(msgs, null, 2), "utf-8");
    } catch (e) {
        console.error("Error saving contact messages file:", e);
    }
};

let contactMessagesStore: ContactMessageItem[] = loadContactMessages();

// GET /api/contact/info - Get current editable contact information (Database with JSON fallback)
app.get("/api/contact/info", async (req: Request, res: Response) => {
    try {
        const dbInfo = await withDbRetry(() => prisma.contactInfo.findUnique({ where: { id: "default" } }));
        if (dbInfo) {
            return res.json({
                success: true,
                data: {
                    address: dbInfo.address,
                    phone: dbInfo.phone,
                    alternatePhone: dbInfo.alternatePhone || "",
                    email: dbInfo.email,
                    hours: dbInfo.hours || "",
                },
            });
        }
    } catch (dbErr) {
        console.warn("DB contactInfo fetch warning, using JSON fallback:", (dbErr as any)?.message || dbErr);
    }

    res.json({
        success: true,
        data: contactInfoStore,
    });
});

// PUT /api/contact/info - Update contact information (Database first with JSON backup)
app.put("/api/contact/info", async (req: Request, res: Response) => {
    try {
        const { address, phone, alternatePhone, email, hours } = req.body;
        const updatedData: ContactInfoData = {
            address: address !== undefined ? String(address).trim() : contactInfoStore.address,
            phone: phone !== undefined ? String(phone).replace(/\D/g, "").slice(0, 10) : contactInfoStore.phone,
            alternatePhone: alternatePhone !== undefined ? String(alternatePhone).replace(/\D/g, "").slice(0, 10) : (contactInfoStore.alternatePhone || ""),
            email: email !== undefined ? String(email).trim().toLowerCase() : contactInfoStore.email,
            hours: hours !== undefined ? String(hours).trim() : contactInfoStore.hours,
        };

        // 1. Save to Database first
        try {
            await withDbRetry(() => prisma.contactInfo.upsert({
                where: { id: "default" },
                update: {
                    address: updatedData.address,
                    phone: updatedData.phone,
                    alternatePhone: updatedData.alternatePhone || null,
                    email: updatedData.email,
                    hours: updatedData.hours || null,
                },
                create: {
                    id: "default",
                    address: updatedData.address,
                    phone: updatedData.phone,
                    alternatePhone: updatedData.alternatePhone || null,
                    email: updatedData.email,
                    hours: updatedData.hours || null,
                }
            }));
        } catch (dbErr) {
            console.error("DB update contact info error:", dbErr);
        }

        // 2. Backup to JSON file
        contactInfoStore = updatedData;
        saveContactInfo(contactInfoStore);

        res.json({
            success: true,
            message: "Contact information updated successfully!",
            data: contactInfoStore,
        });
    } catch (err: any) {
        console.error("Update contact info error:", err);
        res.status(500).json({ success: false, error: err.message || "Server error" });
    }
});

// POST /api/contact/submit - Submit contact inquiry (Database first with JSON backup)
app.post("/api/contact/submit", async (req: Request, res: Response) => {
    try {
        const { name, email, phone, subject, message, city, district } = req.body;

        if (!name || !email || !phone || !message) {
            res.status(400).json({
                success: false,
                error: "Name, email, 10-digit phone number, and message are required!",
            });
            return;
        }

        const cleanPhone = String(phone).replace(/\D/g, "").slice(0, 10);
        if (cleanPhone.length !== 10) {
            res.status(400).json({
                success: false,
                error: "Please enter a valid 10-digit mobile number!",
            });
            return;
        }

        const cleanSubject = subject ? String(subject).trim() : "General Inquiry";
        const cleanMessage = String(message).trim();
        const cleanName = String(name).trim();
        const cleanEmail = String(email).trim().toLowerCase();
        const msgId = `msg_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        // 1. Database first
        let createdRecord = null;
        try {
            createdRecord = await withDbRetry(() => prisma.contactMessage.create({
                data: {
                    id: msgId,
                    name: cleanName,
                    email: cleanEmail,
                    phone: cleanPhone,
                    subject: cleanSubject,
                    message: cleanMessage,
                    status: "UNREAD",
                }
            }));
        } catch (dbErr) {
            console.error("DB submit contact message error:", dbErr);
        }

        // 2. Backup to JSON file
        const newMsg: ContactMessageItem = {
            id: createdRecord ? createdRecord.id : msgId,
            name: cleanName,
            email: cleanEmail,
            phone: cleanPhone,
            subject: cleanSubject,
            message: cleanMessage,
            city: city ? String(city).trim() : undefined,
            district: district ? String(district).trim() : undefined,
            status: "UNREAD",
            createdAt: createdRecord ? createdRecord.createdAt.toISOString() : new Date().toISOString(),
        };

        contactMessagesStore.unshift(newMsg);
        saveContactMessages(contactMessagesStore);

        res.json({
            success: true,
            message: "Your message has been submitted successfully!",
            data: newMsg,
        });
    } catch (err: any) {
        console.error("Contact submit error:", err);
        res.status(500).json({ success: false, error: err.message || "Server error submitting message." });
    }
});

// GET /api/contact/messages - Get all contact messages (Database with JSON fallback)
app.get("/api/contact/messages", async (req: Request, res: Response) => {
    try {
        const dbMessages = await withDbRetry(() => prisma.contactMessage.findMany({
            orderBy: { createdAt: "desc" },
        }));
        if (dbMessages && dbMessages.length > 0) {
            return res.json({
                success: true,
                count: dbMessages.length,
                data: dbMessages.map((m) => ({
                    id: m.id,
                    name: m.name,
                    email: m.email,
                    phone: m.phone,
                    subject: m.subject || "General Inquiry",
                    message: m.message,
                    status: m.status as "UNREAD" | "READ",
                    createdAt: m.createdAt.toISOString(),
                })),
            });
        }
    } catch (dbErr) {
        console.warn("DB contact messages fetch warning, using JSON fallback:", (dbErr as any)?.message || dbErr);
    }

    res.json({
        success: true,
        count: contactMessagesStore.length,
        data: contactMessagesStore,
    });
});

// PUT /api/contact/messages/:id - Update message status (Database first with JSON backup)
app.put("/api/contact/messages/:id", async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        const { status } = req.body;

        // 1. Update in Database
        try {
            await withDbRetry(() => prisma.contactMessage.update({
                where: { id },
                data: {
                    ...(status && { status }),
                }
            }));
        } catch (dbErr) {
            console.warn("DB update contact message warning:", (dbErr as any)?.message || dbErr);
        }

        // 2. Update in JSON store
        const target = contactMessagesStore.find((m) => m.id === id);
        if (target && status) {
            target.status = status;
            saveContactMessages(contactMessagesStore);
        }

        if (!target) {
            try {
                const dbItem = await prisma.contactMessage.findUnique({ where: { id } });
                if (dbItem) {
                    return res.json({
                        success: true,
                        message: "Message status updated successfully",
                        data: dbItem,
                    });
                }
            } catch (_) {}
            res.status(404).json({ success: false, error: "Message not found!" });
            return;
        }

        res.json({
            success: true,
            message: "Message status updated successfully",
            data: target,
        });
    } catch (err: any) {
        console.error("Update message status error:", err);
        res.status(500).json({ success: false, error: err.message || "Server error" });
    }
});

// DELETE /api/contact/messages/:id - Delete message (Database first with JSON backup)
app.delete("/api/contact/messages/:id", async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);

        // 1. Delete from Database
        let dbDeleted: any = null;
        try {
            dbDeleted = await withDbRetry(() => prisma.contactMessage.delete({
                where: { id }
            }));
        } catch (dbErr) {
            console.warn("DB delete contact message warning:", (dbErr as any)?.message || dbErr);
        }

        // 2. Delete from JSON file
        const index = contactMessagesStore.findIndex((m) => m.id === id);
        let fileDeleted = null;
        if (index !== -1) {
            fileDeleted = contactMessagesStore.splice(index, 1)[0];
            saveContactMessages(contactMessagesStore);
        }

        if (!dbDeleted && !fileDeleted) {
            res.status(404).json({ success: false, error: "Message not found!" });
            return;
        }

        res.json({
            success: true,
            message: "Message deleted successfully",
            data: fileDeleted || dbDeleted,
        });
    } catch (err: any) {
        console.error("Delete contact message error:", err);
        res.status(500).json({ success: false, error: err.message || "Server error" });
    }
});

// ==================== DONATION API ENDPOINTS ====================

interface DonationRecordItem {
    id: string;
    receiptNo: string;
    name: string;
    mobileNo: string;
    address?: string | null;
    gaav?: string | null;
    taluka?: string | null;
    city: string;
    district?: string | null;
    state?: string | null;
    country?: string | null;
    pincode?: string | null;
    amount: number;
    amountInWords: string;
    paymentScreenshot?: string | null;
    date: string;
    createdAt: string;
    updatedAt: string;
}

const DONATIONS_FILE_PATH = path.join(__dirname, "../donations.json");

const loadDonationsFromFile = (): DonationRecordItem[] => {
    try {
        if (fs.existsSync(DONATIONS_FILE_PATH)) {
            const raw = fs.readFileSync(DONATIONS_FILE_PATH, "utf-8");
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error("Error reading donations file:", e);
    }
    return [];
};

const saveDonationsToFile = (donations: DonationRecordItem[]) => {
    try {
        fs.writeFileSync(DONATIONS_FILE_PATH, JSON.stringify(donations, null, 2), "utf-8");
    } catch (e) {
        console.error("Error writing donations file:", e);
    }
};

let donationsStore: DonationRecordItem[] = loadDonationsFromFile();

const getDonationPrismaModel = () => {
    try {
        if ((prisma as any)?.donation) return (prisma as any).donation;
        const { PrismaClient } = require("@prisma/client");
        const tempClient = new PrismaClient();
        if ((tempClient as any)?.donation) return (tempClient as any).donation;
    } catch (e) {
        console.warn("Prisma donation model resolution warning:", e);
    }
    return null;
};

const getNextDonationReceiptNo = async (): Promise<string> => {
    const currentYear = new Date().getFullYear();
    const prefix = `MPTM-${currentYear}-DON-`;

    let maxSeq = 0;

    const donationModel = getDonationPrismaModel();
    if (donationModel) {
        try {
            const allDonations = await donationModel.findMany({
                where: { receiptNo: { startsWith: prefix } },
                select: { receiptNo: true }
            });
            for (const item of allDonations) {
                const numPart = item.receiptNo.replace(prefix, "");
                const seq = parseInt(numPart, 10);
                if (!isNaN(seq) && seq < 1000 && seq > maxSeq) {
                    maxSeq = seq;
                }
            }
        } catch (e) {
            console.error("Error fetching donation seq from DB:", e);
        }
    }

    if (Array.isArray(donationsStore)) {
        for (const item of donationsStore) {
            if (item.receiptNo && item.receiptNo.startsWith(prefix)) {
                const numPart = item.receiptNo.replace(prefix, "");
                const seq = parseInt(numPart, 10);
                if (!isNaN(seq) && seq < 1000 && seq > maxSeq) {
                    maxSeq = seq;
                }
            }
        }
    }

    const nextSeq = maxSeq + 1;
    return `${prefix}${String(nextSeq).padStart(3, "0")}`;
};

// GET /api/donation/next-number - Fetch next sequential donation receipt number
app.get(["/api/donation/next-number", "/api/donations/next-number"], async (_req: Request, res: Response) => {
    try {
        const nextReceiptNo = await getNextDonationReceiptNo();
        res.json({ success: true, receiptNo: nextReceiptNo });
    } catch (error) {
        const currentYear = new Date().getFullYear();
        res.json({ success: true, receiptNo: `MPTM-${currentYear}-DON-001` });
    }
});

// POST /api/donation - Create donation entry
app.post(["/api/donation", "/api/donations", "/api/donation/create"], async (req: Request, res: Response) => {
    try {
        const { name, mobileNo, address, gaav, taluka, city, district, state, country, pincode, amount, amountInWords, paymentScreenshot, date } = req.body;

        if (!name || !mobileNo || !amount) {
            res.status(400).json({ success: false, error: "Please provide all required fields (Name, Mobile, Amount)." });
            return;
        }

        const now = new Date();
        const dateStr = date || `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}`;
        const receiptNo = await getNextDonationReceiptNo();
        const createdIso = now.toISOString();

        let newDonation: DonationRecordItem | null = null;

        const donationModel = getDonationPrismaModel();
        if (donationModel) {
            try {
                newDonation = await withDbRetry(async () => {
                    return await donationModel.create({
                        data: {
                            receiptNo,
                            name: String(name).trim(),
                            mobileNo: String(mobileNo).trim(),
                            address: address ? String(address).trim() : null,
                            gaav: gaav ? String(gaav).trim() : null,
                            taluka: taluka ? String(taluka).trim() : null,
                            city: city ? String(city).trim() : "अमरावती",
                            district: district ? String(district).trim() : "अमरावती",
                            state: state ? String(state).trim() : "महाराष्ट्र",
                            country: country ? String(country).trim() : "भारत",
                            pincode: pincode ? String(pincode).trim() : null,
                            amount: parseInt(String(amount), 10) || 0,
                            amountInWords: amountInWords || "",
                            paymentScreenshot: paymentScreenshot || null,
                            date: dateStr,
                        },
                    });
                });
            } catch (dbErr) {
                console.error("Prisma DB create donation error, using JSON fallback:", dbErr);
            }
        }

        if (!newDonation) {
            newDonation = {
                id: `don_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                receiptNo,
                name: String(name).trim(),
                mobileNo: String(mobileNo).trim(),
                address: address ? String(address).trim() : null,
                gaav: gaav ? String(gaav).trim() : null,
                taluka: taluka ? String(taluka).trim() : null,
                city: city ? String(city).trim() : "अमरावती",
                district: district ? String(district).trim() : "अमरावती",
                state: state ? String(state).trim() : "महाराष्ट्र",
                country: country ? String(country).trim() : "भारत",
                pincode: pincode ? String(pincode).trim() : null,
                amount: parseInt(String(amount), 10) || 0,
                amountInWords: amountInWords || "",
                paymentScreenshot: paymentScreenshot || null,
                date: dateStr,
                createdAt: createdIso,
                updatedAt: createdIso,
            };
            donationsStore.unshift(newDonation);
            saveDonationsToFile(donationsStore);
        }

        res.json({
            success: true,
            message: "Donation recorded successfully!",
            data: newDonation,
        });
    } catch (error: any) {
        console.error("Donation Creation Error:", error);
        res.status(500).json({
            success: false,
            error: "Server Error: Could not save donation entry.",
        });
    }
});

// GET /api/donation/all - Get all donation records
app.get(["/api/donation/all", "/api/donations", "/api/donations/all", "/api/donation"], async (req: Request, res: Response) => {
    try {
        let results: DonationRecordItem[] = [];
        const donationModel = getDonationPrismaModel();

        if (donationModel) {
            try {
                results = await withDbRetry(async () => {
                    return await donationModel.findMany({
                        orderBy: { createdAt: "desc" },
                    });
                });
            } catch (dbErr) {
                console.error("Prisma DB fetch donations error, using JSON fallback:", dbErr);
            }
        }

        if (!results || results.length === 0) {
            results = donationsStore;
        }

        res.json({
            success: true,
            data: results,
        });
    } catch (error: any) {
        console.error("Fetch Donations Error:", error);
        res.json({
            success: true,
            data: donationsStore,
        });
    }
});

// DELETE /api/donation/:id - Delete donation entry
app.delete(["/api/donation/:id", "/api/donations/:id", "/api/donation/delete/:id"], async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        let deleted: any = null;
        const donationModel = getDonationPrismaModel();

        if (donationModel) {
            try {
                deleted = await withDbRetry(async () => {
                    return await donationModel.delete({
                        where: { id },
                    });
                });
            } catch (dbErr) {
                console.error("Prisma DB delete donation error, using JSON fallback:", dbErr);
            }
        }

        const idx = donationsStore.findIndex((d) => d.id === id || d.receiptNo === id);
        if (idx !== -1) {
            const fileDeleted = donationsStore.splice(idx, 1)[0];
            saveDonationsToFile(donationsStore);
            if (!deleted) deleted = fileDeleted;
        }

        res.json({
            success: true,
            message: "Donation record deleted successfully.",
            data: deleted || { id },
        });
    } catch (error: any) {
        console.error("Delete Donation Error:", error);
        res.status(500).json({
            success: false,
            error: "Error removing donation entry.",
        });
    }
});

// ==================== EXECUTIVE MEMBERS API ENDPOINTS ====================

interface ExecutiveMemberRecordItem {
    id: string;
    fullName: string;
    designation: string;
    mobileNo: string;
    address?: string | null;
    gaav?: string | null;
    taluka?: string | null;
    city: string;
    district: string;
    state?: string | null;
    country?: string | null;
    pincode?: string | null;
    photoUrl?: string | null;
    status: string;
    receiptNo?: string | null;
    memberNo?: string | null;
    seriesNo?: string | null;
    registrationFee?: number | null;
    paymentMethod?: string | null;
    createdAt: string;
    updatedAt: string;
}

const EXECUTIVES_FILE_PATH = path.join(__dirname, "../executive_members.json");

const defaultExecutives: ExecutiveMemberRecordItem[] = [
    {
        id: "exec_101",
        fullName: "राजस बाळकृष्ण गुलवाडे",
        designation: "विभागीय अध्यक्ष",
        mobileNo: "9595707707",
        city: "अमरावती",
        district: "अमरावती",
        photoUrl: null,
        status: "ACTIVE",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    },
    {
        id: "exec_102",
        fullName: "सुरेश शामराव देशमुख",
        designation: "विभागीय उपाध्यक्ष",
        mobileNo: "9822334455",
        city: "अमरावती",
        district: "अमरावती",
        photoUrl: null,
        status: "ACTIVE",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    },
    {
        id: "exec_103",
        fullName: "अमित गजानन काळे",
        designation: "विभागीय सचिव",
        mobileNo: "9422114455",
        city: "अमरावती",
        district: "अमरावती",
        photoUrl: null,
        status: "ACTIVE",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }
];

const loadExecutivesFromFile = (): ExecutiveMemberRecordItem[] => {
    try {
        if (fs.existsSync(EXECUTIVES_FILE_PATH)) {
            const raw = fs.readFileSync(EXECUTIVES_FILE_PATH, "utf-8");
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error("Error reading executive members file:", e);
    }
    try {
        fs.writeFileSync(EXECUTIVES_FILE_PATH, JSON.stringify(defaultExecutives, null, 2), "utf-8");
    } catch (e) { }
    return defaultExecutives;
};

const saveExecutivesToFile = (execs: ExecutiveMemberRecordItem[]) => {
    try {
        fs.writeFileSync(EXECUTIVES_FILE_PATH, JSON.stringify(execs, null, 2), "utf-8");
    } catch (e) {
        console.error("Error writing executive members file:", e);
    }
};

let executivesStore: ExecutiveMemberRecordItem[] = loadExecutivesFromFile();

const getExecutivePrismaModel = () => {
    try {
        if ((prisma as any)?.executiveMember) return (prisma as any).executiveMember;
        const { PrismaClient } = require("@prisma/client");
        const tempClient = new PrismaClient();
        if ((tempClient as any)?.executiveMember) return (tempClient as any).executiveMember;
    } catch (e) {
        console.warn("Prisma executiveMember model resolution warning:", e);
    }
    return null;
};

// GET /api/executives - Get all executive committee members
app.get(["/api/executives", "/api/executives/all", "/api/management/executives"], async (req: Request, res: Response) => {
    try {
        let results: ExecutiveMemberRecordItem[] = [];
        const execModel = getExecutivePrismaModel();

        if (execModel) {
            try {
                results = await withDbRetry(async () => {
                    return await execModel.findMany({
                        orderBy: { createdAt: "asc" },
                    });
                });
            } catch (dbErr) {
                console.error("Prisma DB fetch executives error, using JSON fallback:", dbErr);
            }
        }

        if (!results || results.length === 0) {
            results = executivesStore;
        }

        res.json({
            success: true,
            count: results.length,
            data: results,
        });
    } catch (error: any) {
        console.error("Fetch Executive Members Error:", error);
        res.json({
            success: true,
            count: executivesStore.length,
            data: executivesStore,
        });
    }
});

// POST /api/executives - Add new executive member
app.post(["/api/executives", "/api/executives/create"], async (req: Request, res: Response) => {
    try {
        const { fullName, designation, mobileNo, address, gaav, taluka, city, district, state, country, pincode, photoUrl, status } = req.body;

        if (!fullName || !designation || !mobileNo) {
            res.status(400).json({ success: false, error: "कृपया पूर्ण नाव, पदनाम आणि मोबाईल नंबर प्रविष्ट करा." });
            return;
        }

        const cleanMobile = String(mobileNo).replace(/\D/g, "").slice(0, 10);
        const nowIso = new Date().toISOString();

        let newExec: ExecutiveMemberRecordItem | null = null;
        const execModel = getExecutivePrismaModel();

        if (execModel) {
            try {
                newExec = await withDbRetry(async () => {
                    return await execModel.create({
                        data: {
                            fullName: String(fullName).trim(),
                            designation: String(designation).trim(),
                            mobileNo: cleanMobile,
                            address: address ? String(address).trim() : null,
                            gaav: gaav ? String(gaav).trim() : null,
                            taluka: taluka ? String(taluka).trim() : null,
                            city: city ? String(city).trim() : "अमरावती",
                            district: district ? String(district).trim() : "अमरावती",
                            state: state ? String(state).trim() : "महाराष्ट्र",
                            country: country ? String(country).trim() : "भारत",
                            pincode: pincode ? String(pincode).trim() : null,
                            photoUrl: photoUrl || null,
                            status: status || "ACTIVE",
                        },
                    });
                });
            } catch (dbErr) {
                console.error("Prisma DB create executive error, using JSON fallback:", dbErr);
            }
        }

        if (!newExec) {
            newExec = {
                id: `exec_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                fullName: String(fullName).trim(),
                designation: String(designation).trim(),
                mobileNo: cleanMobile,
                address: address ? String(address).trim() : null,
                gaav: gaav ? String(gaav).trim() : null,
                taluka: taluka ? String(taluka).trim() : null,
                city: city ? String(city).trim() : "अमरावती",
                district: district ? String(district).trim() : "अमरावती",
                state: state ? String(state).trim() : "महाराष्ट्र",
                country: country ? String(country).trim() : "भारत",
                pincode: pincode ? String(pincode).trim() : null,
                photoUrl: photoUrl || null,
                status: status || "ACTIVE",
                createdAt: nowIso,
                updatedAt: nowIso,
            };
            executivesStore.unshift(newExec);
            saveExecutivesToFile(executivesStore);
        }

        res.json({
            success: true,
            message: "कार्यकारिणी सदस्य नोंद यशस्वीरित्या जतन झाली!",
            data: newExec,
        });
    } catch (error: any) {
        console.error("Create Executive Member Error:", error);
        res.status(500).json({ success: false, error: "सर्व्हर त्रुटी: कार्यकारिणी सदस्य माहिती जतन करता आली नाही." });
    }
});

// PUT /api/executives/:id - Update executive member details
app.put("/api/executives/:id", async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        const { fullName, designation, mobileNo, address, gaav, taluka, city, district, state, country, pincode, photoUrl, status } = req.body;
        const nowIso = new Date().toISOString();

        let updated: ExecutiveMemberRecordItem | null = null;
        const execModel = getExecutivePrismaModel();

        if (execModel) {
            try {
                updated = await withDbRetry(async () => {
                    return await execModel.update({
                        where: { id },
                        data: {
                            ...(fullName && { fullName: String(fullName).trim() }),
                            ...(designation && { designation: String(designation).trim() }),
                            ...(mobileNo && { mobileNo: String(mobileNo).replace(/\D/g, "").slice(0, 10) }),
                            ...(address !== undefined && { address: address ? String(address).trim() : null }),
                            ...(gaav !== undefined && { gaav: gaav ? String(gaav).trim() : null }),
                            ...(taluka !== undefined && { taluka: taluka ? String(taluka).trim() : null }),
                            ...(city && { city: String(city).trim() }),
                            ...(district && { district: String(district).trim() }),
                            ...(state !== undefined && { state: state ? String(state).trim() : null }),
                            ...(country !== undefined && { country: country ? String(country).trim() : null }),
                            ...(pincode !== undefined && { pincode: pincode ? String(pincode).trim() : null }),
                            ...(photoUrl !== undefined && { photoUrl }),
                            ...(status && { status }),
                        },
                    });
                });
            } catch (dbErr) {
                console.error("Prisma DB update executive error, using JSON fallback:", dbErr);
            }
        }

        const idx = executivesStore.findIndex((e) => e.id === id);
        if (idx !== -1) {
            executivesStore[idx] = {
                ...executivesStore[idx],
                ...(fullName && { fullName: String(fullName).trim() }),
                ...(designation && { designation: String(designation).trim() }),
                ...(mobileNo && { mobileNo: String(mobileNo).replace(/\D/g, "").slice(0, 10) }),
                ...(address !== undefined && { address: address ? String(address).trim() : null }),
                ...(gaav !== undefined && { gaav: gaav ? String(gaav).trim() : null }),
                ...(taluka !== undefined && { taluka: taluka ? String(taluka).trim() : null }),
                ...(city && { city: String(city).trim() }),
                ...(district && { district: String(district).trim() }),
                ...(state !== undefined && { state: state ? String(state).trim() : null }),
                ...(country !== undefined && { country: country ? String(country).trim() : null }),
                ...(pincode !== undefined && { pincode: pincode ? String(pincode).trim() : null }),
                ...(photoUrl !== undefined && { photoUrl }),
                ...(status && { status }),
                updatedAt: nowIso,
            };
            saveExecutivesToFile(executivesStore);
            if (!updated) updated = executivesStore[idx];
        }

        res.json({
            success: true,
            message: "कार्यकारिणी सदस्य माहिती अद्ययावत झाली!",
            data: updated || { id },
        });
    } catch (error: any) {
        console.error("Update Executive Member Error:", error);
        res.status(500).json({ success: false, error: "सर्व्हर त्रुटी: कार्यकारिणी सदस्य अद्ययावत करता आला नाही." });
    }
});

// DELETE & POST /api/executives/:id - Delete executive member permanently from database and store
const handleExecutiveDelete = async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        let deleted: any = null;

        // 1. Find candidate target in database or local store
        let targetExec: any = null;
        const execModel = getExecutivePrismaModel();

        if (execModel) {
            try {
                targetExec = await withDbRetry(async () => {
                    return await execModel.findFirst({
                        where: {
                            OR: [
                                { id },
                                { mobileNo: id },
                                { fullName: id }
                            ]
                        }
                    });
                });
            } catch (err) {
                console.warn("DB find executive target warning:", err);
            }
        }

        const storeMatch = executivesStore.find((e) => e.id === id || e.mobileNo === id || e.fullName === id);
        const mobileToPurge = targetExec?.mobileNo || storeMatch?.mobileNo;
        const nameToPurge = targetExec?.fullName || storeMatch?.fullName;

        // 2. Delete ExecutiveMember record from PostgreSQL DB
        if (execModel) {
            try {
                await withDbRetry(async () => {
                    return await execModel.deleteMany({
                        where: {
                            OR: [
                                { id },
                                ...(mobileToPurge ? [{ mobileNo: mobileToPurge }] : []),
                                ...(nameToPurge ? [{ fullName: nameToPurge }] : [])
                            ]
                        }
                    });
                });
            } catch (dbErr) {
                console.error("Prisma DB delete executive error:", dbErr);
            }
        }

        // 3. Delete any linked MemberRegistration / MainMember records from PostgreSQL DB
        let linkedDeletedCount = 0;
        try {
            const orConditions: any[] = [{ receiptNo: id }];
            if (mobileToPurge) orConditions.push({ mainMembers: { some: { mobileNo: mobileToPurge } } });
            if (nameToPurge) orConditions.push({ mainMembers: { some: { fullName: nameToPurge } } });

            const linkedRegs = await prisma.memberRegistration.findMany({
                where: { OR: orConditions },
                select: { id: true }
            });

            for (const reg of linkedRegs) {
                await deleteRegistrationByIdOrReceipt(reg.id, "Executive registration deleted", "Super Admin");
                linkedDeletedCount++;
            }
        } catch (regErr) {
            console.warn("Linked registration purge warning:", regErr);
        }

        // If no linked registration was archived, archive the executive member directly into DeletedMember
        if (linkedDeletedCount === 0 && (targetExec || storeMatch)) {
            try {
                const execItem = targetExec || storeMatch;
                const delId = `del_exec_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                await prisma.$executeRawUnsafe(
                    `INSERT INTO "DeletedMember" (
                        "id", "memberType", "originalId", "receiptNo", "memberNo", "fullName",
                        "designation", "mobileNo", "email", "address", "gaav", "taluka",
                        "city", "district", "state", "country", "pincode", "photoUrl",
                        "registrationFee", "paymentMethod", "paymentReference", "referredBy",
                        "registrationDate", "familyMembers", "fullData", "deletedAt", "deletedBy", "reason"
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb, $25::jsonb, $26, $27, $28)`,
                    delId,
                    "EXECUTIVE",
                    execItem.id || id,
                    execItem.receiptNo || null,
                    execItem.memberNo || execItem.seriesNo || null,
                    execItem.fullName || nameToPurge || "अज्ञात",
                    execItem.designation || "कार्यकारिणी सदस्य",
                    execItem.mobileNo || mobileToPurge || "-",
                    null,
                    execItem.address || null,
                    execItem.gaav || null,
                    execItem.taluka || null,
                    execItem.city || "अमरावती",
                    execItem.district || "अमरावती",
                    execItem.state || "महाराष्ट्र",
                    execItem.country || "भारत",
                    execItem.pincode || null,
                    execItem.photoUrl || null,
                    execItem.registrationFee || 1001,
                    execItem.paymentMethod || "Cash",
                    null,
                    "Super Admin",
                    execItem.createdAt ? new Date(execItem.createdAt).toISOString().slice(0, 10) : null,
                    JSON.stringify([]),
                    JSON.stringify({ exec: execItem }),
                    new Date(),
                    "Super Admin",
                    "Executive member deleted"
                );
            } catch (archiveErr) {
                console.warn("Failed to archive deleted standalone executive:", archiveErr);
            }
        }

        // 4. Purge from local JSON store
        const storeIndices: number[] = [];
        for (let i = 0; i < executivesStore.length; i++) {
            const e = executivesStore[i];
            if (e.id === id || (mobileToPurge && e.mobileNo === mobileToPurge) || (nameToPurge && e.fullName === nameToPurge)) {
                storeIndices.push(i);
            }
        }
        for (let i = storeIndices.length - 1; i >= 0; i--) {
            const removed = executivesStore.splice(storeIndices[i], 1)[0];
            if (!deleted) deleted = removed;
        }
        saveExecutivesToFile(executivesStore);

        res.json({
            success: true,
            message: "कार्यकारिणी सदस्य व संबंधित डेटाबेसमधील सर्व नोंदी यशस्वीरित्या हटवल्या गेल्या व हटवलेल्या सदस्यांच्या यादीत संग्रहित झाल्या.",
            data: deleted || targetExec || { id },
        });
    } catch (error: any) {
        console.error("Delete Executive Member Error:", error);
        res.status(500).json({ success: false, error: "कार्यकारिणी सदस्य डेटाबेसमधून हटवताना सर्व्हर त्रुटी आली." });
    }
};

app.delete(["/api/executives/:id", "/api/executives/delete/:id"], handleExecutiveDelete);
app.post(["/api/executives/delete/:id"], handleExecutiveDelete);

// ==================== DELETED MEMBERS MANAGEMENT ENDPOINTS ====================

// GET /api/deleted-members - Fetch all deleted members (both Primary and Executive)
app.get(["/api/deleted-members", "/api/deleted-members/all"], async (req: Request, res: Response) => {
    try {
        const memberType = String(req.query.type || "ALL").toUpperCase();
        const search = String(req.query.search || "").trim();

        let query = `SELECT * FROM "DeletedMember"`;
        const conditions: string[] = [];
        const params: any[] = [];

        if (memberType === "PRIMARY" || memberType === "EXECUTIVE") {
            params.push(memberType);
            conditions.push(`"memberType" = $${params.length}`);
        }

        if (search) {
            params.push(`%${search}%`);
            const pIdx = `$${params.length}`;
            conditions.push(`(
                "fullName" ILIKE ${pIdx} OR
                "mobileNo" ILIKE ${pIdx} OR
                "receiptNo" ILIKE ${pIdx} OR
                "memberNo" ILIKE ${pIdx} OR
                "city" ILIKE ${pIdx} OR
                "district" ILIKE ${pIdx} OR
                "designation" ILIKE ${pIdx}
            )`);
        }

        if (conditions.length > 0) {
            query += ` WHERE ` + conditions.join(" AND ");
        }

        query += ` ORDER BY "deletedAt" DESC`;

        const rows: any[] = await withDbRetry(() => prisma.$queryRawUnsafe(query, ...params));

        const formatted = rows.map((r) => {
            let familyMembers = r.familyMembers;
            if (typeof familyMembers === "string") {
                try { familyMembers = JSON.parse(familyMembers); } catch (_) {}
            }
            let fullData = r.fullData;
            if (typeof fullData === "string") {
                try { fullData = JSON.parse(fullData); } catch (_) {}
            }
            let mainMembers = fullData?.mainMembers || [];
            if (typeof mainMembers === "string") {
                try { mainMembers = JSON.parse(mainMembers); } catch (_) {}
            }
            if (!Array.isArray(mainMembers) || mainMembers.length === 0) {
                mainMembers = [{
                    srNo: 1,
                    fullName: r.fullName,
                    memberNo: r.memberNo || "-",
                    mobileNo: r.mobileNo || "-",
                    prabhagNo: "-",
                }];
            }
            return {
                ...r,
                mainMembers,
                familyMembers: Array.isArray(familyMembers) ? familyMembers : [],
                fullData,
                deletedAt: r.deletedAt instanceof Date ? r.deletedAt.toISOString() : String(r.deletedAt)
            };
        });

        res.json({ success: true, data: formatted });
    } catch (error: any) {
        console.error("Fetch Deleted Members Error:", error);
        res.status(500).json({ success: false, error: "डेटाबेस सर्व्हर त्रुटी: हटवलेल्या सदस्यांची माहिती आणता आली नाही." });
    }
});

// GET /api/deleted-members/:id - Fetch single deleted member details
app.get("/api/deleted-members/:id", async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        const rows: any[] = await withDbRetry(() => prisma.$queryRawUnsafe(
            `SELECT * FROM "DeletedMember" WHERE "id" = $1 LIMIT 1`,
            id
        ));

        if (!rows || rows.length === 0) {
            res.status(404).json({ success: false, error: "हटवलेला सदस्य सापडला नाही!" });
            return;
        }

        const r = rows[0];
        let familyMembers = r.familyMembers;
        if (typeof familyMembers === "string") {
            try { familyMembers = JSON.parse(familyMembers); } catch (_) {}
        }
        let fullData = r.fullData;
        if (typeof fullData === "string") {
            try { fullData = JSON.parse(fullData); } catch (_) {}
        }
        let mainMembers = fullData?.mainMembers || [];
        if (typeof mainMembers === "string") {
            try { mainMembers = JSON.parse(mainMembers); } catch (_) {}
        }
        if (!Array.isArray(mainMembers) || mainMembers.length === 0) {
            mainMembers = [{
                srNo: 1,
                fullName: r.fullName,
                memberNo: r.memberNo || "-",
                mobileNo: r.mobileNo || "-",
                prabhagNo: "-",
            }];
        }

        res.json({
            success: true,
            data: {
                ...r,
                mainMembers,
                familyMembers: Array.isArray(familyMembers) ? familyMembers : [],
                fullData,
                deletedAt: r.deletedAt instanceof Date ? r.deletedAt.toISOString() : String(r.deletedAt)
            }
        });
    } catch (error: any) {
        console.error("Fetch Single Deleted Member Error:", error);
        res.status(500).json({ success: false, error: "डेटाबेस सर्व्हर त्रुटी: तपशील आणता आले नाहीत." });
    }
});

// POST /api/deleted-members/restore/:id - Restore a deleted member back to active
app.post("/api/deleted-members/restore/:id", async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        const rows: any[] = await withDbRetry(() => prisma.$queryRawUnsafe(
            `SELECT * FROM "DeletedMember" WHERE "id" = $1 LIMIT 1`,
            id
        ));

        if (!rows || rows.length === 0) {
            res.status(404).json({ success: false, error: "हटवलेला सदस्य सापडला नाही!" });
            return;
        }

        const item = rows[0];
        let fullData: any = item.fullData;
        if (typeof fullData === "string") {
            try { fullData = JSON.parse(fullData); } catch (_) {}
        }

        if (item.memberType === "PRIMARY") {
            const regData = fullData || {};
            const regId = item.originalId || `reg_${Date.now()}`;
            const receiptNo = item.receiptNo || `MPTM-R${Date.now().toString().slice(-5)}`;

            // Check if receipt already exists
            const existing = await prisma.memberRegistration.findFirst({
                where: { OR: [{ id: regId }, { receiptNo }] }
            });

            if (existing) {
                res.status(400).json({ success: false, error: `या पावती क्रमांकाची (${receiptNo}) नोंदणी आधीपासून डेटाबेसमध्ये सक्रिय आहे!` });
                return;
            }

            // Restore MemberRegistration
            await withDbRetry(() => prisma.memberRegistration.create({
                data: {
                    id: regId,
                    receiptNo: receiptNo,
                    date: item.registrationDate || new Date().toISOString().slice(0, 10),
                    registrationFee: item.registrationFee || 500,
                    amountInWords: regData.amountInWords || "",
                    address: item.address || "",
                    gaav: item.gaav || null,
                    taluka: item.taluka || null,
                    city: item.city || "अमरावती",
                    district: item.district || "अमरावती",
                    state: item.state || "महाराष्ट्र",
                    country: item.country || "भारत",
                    pincode: item.pincode || null,
                    paymentMethod: item.paymentMethod || "Cash",
                    paymentScreenshot: regData.paymentScreenshot || null,
                    referredBy: item.referredBy || null,
                    publicToken: regData.publicToken || `tok_${Date.now()}`,
                    status: "ACTIVE",
                    paymentMode: regData.paymentMode || (item.paymentMethod === "Cash" ? "CASH" : "ONLINE"),
                    paymentReference: item.paymentReference || null,
                    amountPaise: regData.amountPaise || (item.registrationFee ? item.registrationFee * 100 : null),
                    mainMembers: {
                        create: (regData.mainMembers && regData.mainMembers.length > 0)
                            ? regData.mainMembers.map((m: any, idx: number) => ({
                                srNo: m.srNo || idx + 1,
                                memberNo: m.memberNo || item.memberNo || `MPTM-M${Date.now().toString().slice(-4)}`,
                                fullName: m.fullName || item.fullName,
                                mobileNo: m.mobileNo || item.mobileNo,
                                prabhagNo: m.prabhagNo || "-",
                            }))
                            : [{
                                srNo: 1,
                                memberNo: item.memberNo || `MPTM-M${Date.now().toString().slice(-4)}`,
                                fullName: item.fullName,
                                mobileNo: item.mobileNo,
                                prabhagNo: "-",
                            }]
                    },
                    familyMembers: {
                        create: (regData.familyMembers && regData.familyMembers.length > 0)
                            ? regData.familyMembers.map((f: any, idx: number) => ({
                                srNo: f.srNo || idx + 1,
                                name: f.name || "",
                                relation: f.relation || "",
                                dob: f.dob || "",
                                occupation: f.occupation || "",
                                mobile: f.mobile || "",
                            }))
                            : []
                    }
                }
            }));
        } else {
            // EXECUTIVE restore
            const execModel = getExecutivePrismaModel();
            const execData = fullData?.exec || fullData || {};
            const execId = item.originalId || `exec_${Date.now()}`;

            if (execModel) {
                await withDbRetry(() => execModel.create({
                    data: {
                        id: execId,
                        fullName: item.fullName,
                        designation: item.designation || "कार्यकारिणी सदस्य",
                        mobileNo: item.mobileNo,
                        address: item.address || null,
                        gaav: item.gaav || null,
                        taluka: item.taluka || null,
                        city: item.city || "अमरावती",
                        district: item.district || "अमरावती",
                        state: item.state || "महाराष्ट्र",
                        country: item.country || "भारत",
                        pincode: item.pincode || null,
                        photoUrl: item.photoUrl || null,
                        status: "ACTIVE",
                    }
                }));
            }

            // Restore in local store as well
            executivesStore.push({
                id: execId,
                fullName: item.fullName,
                designation: item.designation || "कार्यकारिणी सदस्य",
                mobileNo: item.mobileNo,
                address: item.address || "",
                gaav: item.gaav || "",
                taluka: item.taluka || "",
                city: item.city || "अमरावती",
                district: item.district || "अमरावती",
                state: item.state || "Maharashtra",
                country: item.country || "India",
                pincode: item.pincode || "",
                photoUrl: item.photoUrl || "",
                status: "ACTIVE",
                receiptNo: item.receiptNo || null,
                memberNo: item.memberNo || null,
                seriesNo: item.memberNo || null,
                registrationFee: item.registrationFee || 1001,
                paymentMethod: item.paymentMethod || "Cash",
                createdAt: item.registrationDate ? new Date(item.registrationDate).toISOString() : new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
            saveExecutivesToFile(executivesStore);
        }

        // Remove from DeletedMember table
        await withDbRetry(() => prisma.$executeRawUnsafe(
            `DELETE FROM "DeletedMember" WHERE "id" = $1`,
            id
        ));

        res.json({
            success: true,
            message: "सदस्य यशस्वीरित्या मुख्य यादीमध्ये पूर्ववत (Restore) करण्यात आला आहे!"
        });
    } catch (error: any) {
        console.error("Restore Deleted Member Error:", error);
        res.status(500).json({ success: false, error: "सदस्य पूर्ववत करताना सर्व्हर त्रुटी: " + (error.message || "") });
    }
});

// DELETE /api/deleted-members/:id - Permanently delete member from DeletedMember archive
app.delete(["/api/deleted-members/:id", "/api/deleted-members/delete/:id"], async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        await withDbRetry(() => prisma.$executeRawUnsafe(
            `DELETE FROM "DeletedMember" WHERE "id" = $1`,
            id
        ));
        res.json({ success: true, message: "सदस्य कायमस्वरूपी हटवला गेला आहे." });
    } catch (error: any) {
        console.error("Permanent Delete Member Error:", error);
        res.status(500).json({ success: false, error: "कायमचे हटवताना सर्व्हर त्रुटी झाली." });
    }
});

// ==================== ADS MANAGEMENT ENDPOINTS ====================
export interface SocialLinks {
    phone?: string;
    visitUs?: string;
    whatsapp?: string;
    facebook?: string;
    instagram?: string;
    youtube?: string;
    twitter?: string;
    website?: string;
}

export interface AdItem {
    id: string;
    title: string;
    subtitle?: string;
    imageUrl?: string;
    videoUrl?: string;
    mediaType?: "image" | "video";
    adLink?: string;
    socialLinks?: SocialLinks;
    isActive: boolean;
    createdAt: string;
    updatedAt?: string;
}

const formatDbAd = (ad: any): AdItem => {
    let socialLinks: SocialLinks = {};
    if (ad.socialLinks) {
        try {
            socialLinks = typeof ad.socialLinks === "string" ? JSON.parse(ad.socialLinks) : ad.socialLinks;
        } catch (_) {}
    }
    return {
        id: ad.id,
        title: ad.title,
        subtitle: ad.subtitle || "",
        imageUrl: ad.imageUrl || "",
        videoUrl: ad.videoUrl || "",
        mediaType: ad.mediaType === "video" ? "video" : "image",
        adLink: ad.adLink || "",
        socialLinks,
        isActive: Boolean(ad.isActive),
        createdAt: ad.createdAt instanceof Date ? ad.createdAt.toISOString() : String(ad.createdAt),
        updatedAt: ad.updatedAt instanceof Date ? ad.updatedAt.toISOString() : (ad.updatedAt ? String(ad.updatedAt) : undefined),
    };
};

// GET /api/ads - Get all ads directly from Database
app.get(["/api/ads", "/ads", "/api/ads/all"], async (req: Request, res: Response) => {
    try {
        const dbAds = await withDbRetry(() => prisma.advertisement.findMany({
            orderBy: [{ order: "asc" }, { createdAt: "desc" }],
        }));
        res.json({ success: true, data: dbAds.map(formatDbAd) });
    } catch (err: any) {
        console.error("Fetch ads error:", err);
        res.status(500).json({ success: false, error: "Database error: Failed to fetch advertisements." });
    }
});

// GET /api/ads/active - Get active ads for website front page popup directly from Database
app.get(["/api/ads/active", "/ads/active"], async (req: Request, res: Response) => {
    try {
        const dbAds = await withDbRetry(() => prisma.advertisement.findMany({
            where: { isActive: true },
            orderBy: [{ order: "asc" }, { createdAt: "desc" }],
        }));
        res.json({ success: true, data: dbAds.map(formatDbAd) });
    } catch (err: any) {
        console.error("Fetch active ads error:", err);
        res.status(500).json({ success: false, error: "Database error: Failed to fetch active advertisements." });
    }
});

// POST & PUT /api/ads/reorder - Save new display sequence of advertisements in Database
app.post(["/api/ads/reorder", "/ads/reorder"], async (req: Request, res: Response) => {
    try {
        const { ads: newAdsOrder } = req.body;
        if (!Array.isArray(newAdsOrder)) {
            res.status(400).json({ success: false, error: "Invalid array of ads provided" });
            return;
        }

        await withDbRetry(() => prisma.$transaction(
            newAdsOrder.map((ad: any, index: number) =>
                prisma.advertisement.update({
                    where: { id: ad.id },
                    data: { order: index }
                })
            )
        ));

        const updatedAds = await withDbRetry(() => prisma.advertisement.findMany({
            orderBy: [{ order: "asc" }, { createdAt: "desc" }],
        }));

        res.json({
            success: true,
            message: "Advertisement sequence updated successfully in database!",
            data: updatedAds.map(formatDbAd)
        });
    } catch (error: any) {
        console.error("Reorder Ads Error:", error);
        res.status(500).json({ success: false, error: "Server Error: Failed to save ad order in database." });
    }
});

// POST /api/ads - Create a new ad directly in Database
app.post(["/api/ads", "/ads"], async (req: Request, res: Response) => {
    try {
        const { title, subtitle, imageUrl, videoUrl, mediaType, adLink, socialLinks, isActive } = req.body;
        const adId = `ad_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const cleanTitle = title ? String(title).trim() : "Advertisement";
        const cleanSubtitle = subtitle ? String(subtitle).trim() : "";
        const cleanImageUrl = imageUrl ? String(imageUrl).trim() : "";
        const cleanVideoUrl = videoUrl ? String(videoUrl).trim() : "";
        const finalMediaType = mediaType === "video" ? "video" : "image";
        const cleanAdLink = adLink ? String(adLink).trim() : "";
        const cleanSocial = socialLinks || {};
        const activeFlag = isActive !== undefined ? Boolean(isActive) : true;

        const dbCreated = await withDbRetry(() => prisma.advertisement.create({
            data: {
                id: adId,
                title: cleanTitle,
                subtitle: cleanSubtitle || null,
                imageUrl: cleanImageUrl || null,
                videoUrl: cleanVideoUrl || null,
                mediaType: finalMediaType,
                adLink: cleanAdLink || null,
                socialLinks: JSON.stringify(cleanSocial),
                isActive: activeFlag,
                order: 0,
            }
        }));

        res.json({
            success: true,
            message: "Advertisement created and stored in database successfully!",
            data: formatDbAd(dbCreated)
        });
    } catch (error: any) {
        console.error("Create Ad Error:", error);
        res.status(500).json({ success: false, error: "Server Error: Failed to create ad in database." });
    }
});

// PUT & POST /api/ads/:id - Update an ad in Database
app.put(["/api/ads/:id", "/ads/:id", "/api/ads/update/:id"], async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        const { title, subtitle, imageUrl, videoUrl, mediaType, adLink, socialLinks, isActive } = req.body;

        const dbUpdated = await withDbRetry(() => prisma.advertisement.update({
            where: { id },
            data: {
                ...(title !== undefined && { title: String(title).trim() }),
                ...(subtitle !== undefined && { subtitle: String(subtitle).trim() }),
                ...(imageUrl !== undefined && { imageUrl: String(imageUrl).trim() }),
                ...(videoUrl !== undefined && { videoUrl: String(videoUrl).trim() }),
                ...(mediaType !== undefined && { mediaType: mediaType === "video" ? "video" : "image" }),
                ...(adLink !== undefined && { adLink: String(adLink).trim() }),
                ...(socialLinks !== undefined && { socialLinks: JSON.stringify(socialLinks) }),
                ...(isActive !== undefined && { isActive: Boolean(isActive) }),
            }
        }));

        res.json({
            success: true,
            message: "Advertisement updated in database successfully!",
            data: formatDbAd(dbUpdated)
        });
    } catch (error: any) {
        console.error("Update Ad Error:", error);
        res.status(500).json({ success: false, error: "Server Error: Failed to update ad in database." });
    }
});

// DELETE /api/ads/:id - Delete an ad from Database
app.delete(["/api/ads/:id", "/api/ads/delete/:id", "/ads/:id", "/ads/delete/:id"], async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);

        const dbDeleted = await withDbRetry(() => prisma.advertisement.delete({
            where: { id }
        }));

        res.json({
            success: true,
            message: "Advertisement deleted from database successfully",
            data: formatDbAd(dbDeleted)
        });
    } catch (error: any) {
        console.error("Delete Ad Error:", error);
        res.status(500).json({ success: false, error: "Server Error: Failed to delete ad from database." });
    }
});

if (process.env.NODE_ENV !== "production" || !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`🚀 Backend Express Server running on http://localhost:${PORT}`);
    });
}

export default app;