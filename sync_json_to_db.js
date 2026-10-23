const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

async function syncAll() {
  console.log("=== STARTING JSON TO DATABASE MIGRATION ===");

  // 1. Career Applications
  const careerPath = path.join(__dirname, 'career_applications.json');
  if (fs.existsSync(careerPath)) {
    try {
      const items = JSON.parse(fs.readFileSync(careerPath, 'utf-8'));
      console.log(`Found ${items.length} career applications in JSON.`);
      for (const item of items) {
        await prisma.careerApplication.upsert({
          where: { id: item.id },
          update: {
            name: item.name,
            email: item.email,
            phone: item.phone,
            position: item.position || 'Office Assistant',
            message: item.message || null,
            city: item.city || null,
            district: item.district || null,
            resumeName: item.resumeName || null,
            resumeData: item.resumeData || null,
            status: item.status || 'PENDING',
          },
          create: {
            id: item.id,
            name: item.name,
            email: item.email,
            phone: item.phone,
            position: item.position || 'Office Assistant',
            message: item.message || null,
            city: item.city || null,
            district: item.district || null,
            resumeName: item.resumeName || null,
            resumeData: item.resumeData || null,
            status: item.status || 'PENDING',
            createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
          }
        });
      }
      console.log("✅ Career applications synced to DB successfully.");
    } catch (e) {
      console.error("Career sync error:", e.message);
    }
  }

  // 2. Contact Messages
  const msgPath = path.join(__dirname, 'contact_messages.json');
  if (fs.existsSync(msgPath)) {
    try {
      const items = JSON.parse(fs.readFileSync(msgPath, 'utf-8'));
      console.log(`Found ${items.length} contact messages in JSON.`);
      for (const item of items) {
        await prisma.contactMessage.upsert({
          where: { id: item.id },
          update: {
            name: item.name,
            email: item.email,
            phone: item.phone,
            subject: item.subject || 'General Inquiry',
            message: item.message,
            status: item.status || 'UNREAD',
          },
          create: {
            id: item.id,
            name: item.name,
            email: item.email,
            phone: item.phone,
            subject: item.subject || 'General Inquiry',
            message: item.message,
            status: item.status || 'UNREAD',
            createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
          }
        });
      }
      console.log("✅ Contact messages synced to DB successfully.");
    } catch (e) {
      console.error("Contact messages sync error:", e.message);
    }
  }

  // 3. Contact Info
  const infoPath = path.join(__dirname, 'contact_info.json');
  if (fs.existsSync(infoPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
      await prisma.contactInfo.upsert({
        where: { id: 'default' },
        update: {
          address: info.address,
          phone: info.phone,
          alternatePhone: info.alternatePhone || null,
          email: info.email,
          hours: info.hours || null,
        },
        create: {
          id: 'default',
          address: info.address,
          phone: info.phone,
          alternatePhone: info.alternatePhone || null,
          email: info.email,
          hours: info.hours || null,
        }
      });
      console.log("✅ Contact info synced to DB successfully.");
    } catch (e) {
      console.error("Contact info sync error:", e.message);
    }
  }

  // 4. Advertisements
  const adsPath = path.join(__dirname, 'ads.json');
  if (fs.existsSync(adsPath)) {
    try {
      const ads = JSON.parse(fs.readFileSync(adsPath, 'utf-8'));
      if (Array.isArray(ads) && ads.length > 0) {
        for (let idx = 0; idx < ads.length; idx++) {
          const ad = ads[idx];
          await prisma.advertisement.upsert({
            where: { id: ad.id },
            update: {
              title: ad.title,
              subtitle: ad.subtitle || null,
              imageUrl: ad.imageUrl || null,
              videoUrl: ad.videoUrl || null,
              mediaType: ad.mediaType || 'image',
              adLink: ad.adLink || null,
              socialLinks: ad.socialLinks ? JSON.stringify(ad.socialLinks) : null,
              isActive: ad.isActive !== undefined ? ad.isActive : true,
              order: idx,
            },
            create: {
              id: ad.id,
              title: ad.title,
              subtitle: ad.subtitle || null,
              imageUrl: ad.imageUrl || null,
              videoUrl: ad.videoUrl || null,
              mediaType: ad.mediaType || 'image',
              adLink: ad.adLink || null,
              socialLinks: ad.socialLinks ? JSON.stringify(ad.socialLinks) : null,
              isActive: ad.isActive !== undefined ? ad.isActive : true,
              order: idx,
              createdAt: ad.createdAt ? new Date(ad.createdAt) : new Date(),
            }
          });
        }
        console.log(`✅ ${ads.length} Ads synced to DB successfully.`);
      }
    } catch (e) {
      console.error("Ads sync error:", e.message);
    }
  }

  // 5. Managed Users
  const usersPath = path.join(__dirname, 'src', 'managed_users.json');
  if (fs.existsSync(usersPath)) {
    try {
      const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
      console.log(`Found ${users.length} managed users in JSON.`);
      for (const u of users) {
        await prisma.managedUser.upsert({
          where: { email: u.email.trim().toLowerCase() },
          update: {
            name: u.name,
            phone: u.phone,
            city: u.city || null,
            date: u.date || null,
            time: u.time || null,
            status: u.status || 'VERIFIED',
            role: u.role || 'User',
          },
          create: {
            id: u.id || `usr_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            email: u.email.trim().toLowerCase(),
            name: u.name,
            phone: u.phone,
            city: u.city || null,
            date: u.date || null,
            time: u.time || null,
            status: u.status || 'VERIFIED',
            role: u.role || 'User',
            createdAt: u.createdAt ? new Date(u.createdAt) : new Date(),
          }
        });
      }
      console.log("✅ Managed users synced to DB successfully.");
    } catch (e) {
      console.error("Managed users sync error:", e.message);
    }
  }

  const finalCounts = {
    career: await prisma.careerApplication.count(),
    contactMessages: await prisma.contactMessage.count(),
    contactInfo: await prisma.contactInfo.count(),
    ads: await prisma.advertisement.count(),
    managedUsers: await prisma.managedUser.count(),
  };

  console.log("=== FINAL DATABASE COUNTS ===", finalCounts);
  await prisma.$disconnect();
}

syncAll().catch(e => {
  console.error(e);
  process.exit(1);
});
