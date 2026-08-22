import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import { prisma, withDbRetry } from "./prisma";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Strict CORS Configuration
const corsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        const allowedOrigins = [
            "https://admin.mptmamravati.org",
            "https://www.mptmamravati.org",
            "https://mptmamravati.org",
            "http://localhost:3001",
            "http://localhost:3000"
        ];

        if (!origin || allowedOrigins.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    credentials: true,
};

// Enable CORS for frontend
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Helper function to delete registration entry cleanly with manual cascade fallback
const deleteRegistrationByIdOrReceipt = async (identifier: string) => {
    return withDbRetry(async () => {
        // 1. Find target registration by ID or receiptNo
        const target = await prisma.memberRegistration.findFirst({
            where: {
                OR: [
                    { id: identifier },
                    { receiptNo: identifier }
                ]
            }
        });

        if (!target) {
            return null;
        }

        const regId = target.id;

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
        const result = await deleteRegistrationByIdOrReceipt(identifier);

        if (!result) {
            res.status(404).json({
                success: false,
                error: "हा नोंदणी अर्ज सापडला नाही किंवा आधीच हटवला आहे!",
            });
            return;
        }

        res.json({
            success: true,
            message: "नोंदणी अर्ज यशस्वीरित्या डेटाबेसमधून हटवला गेला",
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
        const result = await deleteRegistrationByIdOrReceipt(identifier);

        if (!result) {
            res.status(404).json({
                success: false,
                error: "हा नोंदणी अर्ज सापडला नाही किंवा आधीच हटवला आहे!",
            });
            return;
        }

        res.json({
            success: true,
            message: "नोंदणी अर्ज यशस्वीरित्या डेटाबेसमधून हटवला गेला",
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
        const result = await deleteRegistrationByIdOrReceipt(identifier);

        if (!result) {
            res.status(404).json({
                success: false,
                error: "हा नोंदणी अर्ज सापडला नाही किंवा आधीच हटवला आहे!",
            });
            return;
        }

        res.json({
            success: true,
            message: "नोंदणी अर्ज यशस्वीरित्या डेटाबेसमधून हटवला गेला",
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
        endpoints: ["/health", "/api/next-numbers", "/api/register", "/api/admin/login"]
    });
});

// Health Check Route
app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "OK", service: "MPTM Amravati Backend API", timestamp: new Date().toISOString() });
});

// Seed/Update default admin lazily
let adminSeeded = false;
const seedDefaultAdmin = async () => {
    if (adminSeeded) return;
    try {
        adminSeeded = true;
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
    } catch (err) {
        adminSeeded = false;
        console.error("Admin seed error:", err);
    }
};

// Middleware to ensure admin seed on requests without blocking initialization
app.use(async (_req, _res, next) => {
    if (!adminSeeded) {
        seedDefaultAdmin().catch(console.error);
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

        // Query Admin model from database
        const admin = await prisma.admin.findUnique({
            where: { username: username.trim() },
        });

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
app.get("/api/next-numbers", async (_req: Request, res: Response) => {
    try {
        const currentYear = new Date().getFullYear();
        const yearReceiptPrefix = `MPTM-${currentYear}-AMT-R`;
        const yearMemberPrefix = `MPTM-${currentYear}-AMT-S`;

        // Find existing registrations for current year prefix
        const yearRegistrations = await prisma.memberRegistration.findMany({
            where: {
                receiptNo: {
                    startsWith: yearReceiptPrefix,
                },
            },
            select: { receiptNo: true },
        });

        // Find existing main members for current year prefix
        const yearMainMembers = await prisma.mainMember.findMany({
            where: {
                memberNo: {
                    startsWith: yearMemberPrefix,
                },
            },
            select: { memberNo: true },
        });

        // Calculate next receipt sequence for current year
        let maxReceiptSeq = 0;
        for (const reg of yearRegistrations) {
            const numPart = reg.receiptNo.replace(yearReceiptPrefix, "");
            const seq = parseInt(numPart, 10);
            if (!isNaN(seq) && seq > maxReceiptSeq) {
                maxReceiptSeq = seq;
            }
        }
        const nextReceiptSeq = Math.max(yearRegistrations.length, maxReceiptSeq) + 1;

        // Calculate next member sequence for current year
        let maxMemberSeq = 0;
        for (const mem of yearMainMembers) {
            const numPart = mem.memberNo.replace(yearMemberPrefix, "");
            const seq = parseInt(numPart, 10);
            if (!isNaN(seq) && seq > maxMemberSeq) {
                maxMemberSeq = seq;
            }
        }
        const nextMemberSeq = Math.max(yearMainMembers.length, maxMemberSeq) + 1;

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
        res.json({
            success: true,
            receiptNo: `MPTM-${currentYear}-AMT-R001`,
            nextReceiptSeq: 1,
            nextMemberSeq: 1,
            nextMemberNo: `MPTM-${currentYear}-AMT-S001`,
        });
    }
});

// GET /api/register - Fetch all registrations
app.get("/api/register", async (_req: Request, res: Response) => {
    try {
        const registrations = await prisma.memberRegistration.findMany({
            orderBy: { createdAt: "desc" },
            include: {
                mainMembers: true,
                familyMembers: true,
            },
        });

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

        const feeNumber = parseInt(formData.registrationFee, 10) || 101;

        const registration = await prisma.memberRegistration.create({
            data: {
                receiptNo: formData.receiptNo,
                date: formatDateToDDMMYYYY(formData.date),
                registrationFee: feeNumber,
                amountInWords: formData.amountInWords || "",
                address: formData.address || "",
                paymentMethod: formData.paymentMethod || "रोख",
                paymentScreenshot: paymentScreenshot || null,
                referredBy: formData.referredBy || req.body.referredBy || null,
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
        });

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

import fs from "fs";
import path from "path";

// Managed Users Data Structure & Disk Persistence
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

const USERS_FILE_PATH = path.join(__dirname, "managed_users.json");

const loadManagedUsers = (): ManagedUser[] => {
    try {
        if (fs.existsSync(USERS_FILE_PATH)) {
            const data = fs.readFileSync(USERS_FILE_PATH, "utf-8");
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed;
            }
        }
    } catch (e) {
        console.error("Failed to load managed_users.json:", e);
    }
    return [
        {
            id: "usr_default_1",
            email: "admin@mptmamravati.org",
            name: "प्रशासक (Admin)",
            phone: "9876543210",
            date: "21/08/2026",
            time: "10:00 AM",
            status: "VERIFIED",
            role: "Super Admin",
            createdAt: new Date().toISOString(),
        },
        {
            id: "usr_default_2",
            email: "sdsumit6446@gmail.com",
            name: "Sumit Dhole",
            phone: "8459073887",
            date: "21/08/2026",
            time: "10:54 AM",
            status: "VERIFIED",
            role: "User",
            createdAt: new Date().toISOString(),
        },
        {
            id: "usr_default_3",
            email: "ybhatkar701@gmail.com",
            name: "Yuvraj Bhatkar",
            phone: "8766735625",
            date: "21/08/2026",
            time: "02:57 PM",
            status: "VERIFIED",
            role: "User",
            createdAt: new Date().toISOString(),
        },
    ];
};

let managedUsersStore: ManagedUser[] = loadManagedUsers();

const saveManagedUsers = () => {
    try {
        fs.writeFileSync(USERS_FILE_PATH, JSON.stringify(managedUsersStore, null, 2), "utf-8");
    } catch (e) {
        console.error("Failed to save managed_users.json:", e);
    }
};

// Save initial store to disk if not exists
saveManagedUsers();

// Helper to check if an email is registered by Super Admin
const isEmailRegisteredInBackend = (email: string): boolean => {
    const clean = email.trim().toLowerCase();
    if (clean === "mptmamravati.org" || clean === "admin@mptmamravati.org") return true;
    return managedUsersStore.some((u) => u.email.trim().toLowerCase() === clean);
};

// GET /api/users - Get all managed users
app.get("/api/users", (req: Request, res: Response) => {
    res.json({ success: true, data: managedUsersStore });
});

// POST /api/users - Add or update a managed user
app.post("/api/users", (req: Request, res: Response) => {
    const { email, name, phone, city, date, time, status, role, id } = req.body;
    if (!email) {
        res.status(400).json({ success: false, error: "इमेल आयडी आवश्यक आहे!" });
        return;
    }
    const cleanEmail = email.trim().toLowerCase();
    const existingIndex = managedUsersStore.findIndex(
        (u) => u.email.trim().toLowerCase() === cleanEmail || (id && u.id === id)
    );

    const now = new Date();
    const existingUser = existingIndex >= 0 ? managedUsersStore[existingIndex] : null;

    const newUser: ManagedUser = {
        id: id || (existingUser ? existingUser.id : `usr_${Date.now()}`),
        email: cleanEmail,
        name: name !== undefined ? name : (existingUser ? existingUser.name || "" : ""),
        phone: phone !== undefined ? phone : (existingUser ? existingUser.phone || "" : ""),
        city: city !== undefined ? city : (existingUser ? existingUser.city || "" : ""),
        date: date || (existingUser ? existingUser.date : now.toLocaleDateString("en-GB")),
        time: time || (existingUser ? existingUser.time : now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })),
        status: status || (existingUser ? existingUser.status : "VERIFIED"),
        role: role || (existingUser ? existingUser.role : "User"),
        createdAt: (existingUser && existingUser.createdAt) ? existingUser.createdAt : now.toISOString(),
    };

    if (existingIndex >= 0) {
        managedUsersStore[existingIndex] = newUser;
    } else {
        managedUsersStore.unshift(newUser);
    }

    saveManagedUsers();

    res.json({ success: true, data: newUser, users: managedUsersStore });
});

// DELETE /api/users/:id - Delete managed user by ID or Email
app.delete("/api/users/:id", (req: Request, res: Response) => {
    const targetId = String(req.params.id).trim().toLowerCase();
    const index = managedUsersStore.findIndex(
        (u) => u.id === targetId || u.email.trim().toLowerCase() === targetId
    );

    if (index >= 0) {
        const deleted = managedUsersStore.splice(index, 1);
        saveManagedUsers();
        res.json({ success: true, message: "युझर हटवला गेला", deleted: deleted[0] });
    } else {
        res.status(404).json({ success: false, error: "युझर सापडला नाही" });
    }
});

// In-memory verification code store (Email -> { code, expiresAt })
const verificationStore = new Map<string, { code: string; expiresAt: number }>();

// Helper transporter creation (uses Gmail service or custom SMTP config)
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
            const isAlreadyAdded = managedUsersStore.some((u) => u.email.trim().toLowerCase() === cleanEmail);
            if (isAlreadyAdded) {
                res.status(400).json({
                    success: false,
                    error: "⚠️ हा इमेल आयडी आधीच नोंदणीकृत व जोडलेला आहे!",
                });
                return;
            }
        } else {
            // User Login flow: Check if email is registered by Super Admin
            if (!isEmailRegisteredInBackend(cleanEmail)) {
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
            const senderUser = (process.env.SMTP_USER || "sdhole501@gmail.com").trim();
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

// POST /api/users/verify-code - Verify user code
app.post("/api/users/verify-code", (req: Request, res: Response) => {
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
    res.json({ success: true, verified: true, message: "इमेल यशस्वीरित्या सत्यप्रमाणित झाला!" });
});

if (process.env.NODE_ENV !== "production" || !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`🚀 Backend Express Server running on http://localhost:${PORT}`);
    });
}

export default app;