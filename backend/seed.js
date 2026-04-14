const bcrypt = require('bcryptjs');
const db = require('./src/db');

async function seedDatabase() {
  // Wait for database initialization
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    console.log('🌱 Seeding database...');

    // Create sample companies
    const companies = [
      {
        name: 'Dataroom',
        industry: 'Financial Services',
        contact_name: 'Rajesh Sharma',
        contact_email: 'broker@datahub.com',
        contact_phone: '+91-9876543210'
      },
      {
        name: 'Infosys Ltd.',
        industry: 'Technology',
        contact_name: 'Ananya Mehta',
        contact_email: 'buyer2@datahub.com',
        contact_phone: '+91-9876543211'
      },
      {
        name: 'TCS',
        industry: 'Technology',
        contact_name: 'Vikram Singh',
        contact_email: 'vikram@tcs.com',
        contact_phone: '+91-9876543212'
      }
    ];

    console.log('📍 Creating companies...');
    const companyResults = [];
    for (const company of companies) {
      await db.query(`
        INSERT INTO companies (name, industry, contact_name, contact_email, contact_phone)
        VALUES (?, ?, ?, ?, ?)
      `, [company.name, company.industry, company.contact_name, company.contact_email, company.contact_phone]);

      // Get the last inserted company
      const lastCompany = await db.query('SELECT * FROM companies ORDER BY rowid DESC LIMIT 1');
      companyResults.push(lastCompany[0]);
      console.log(`✓ Created company: ${lastCompany[0].name}`);
    }

    // Create users with hashed passwords
    const users = [
      {
        name: 'Rajesh Sharma',
        email: 'broker@datahub.com',
        password: 'Password@123',
        role: 'broker',
        company_name: 'Dataroom'
      },
      {
        name: 'Ananya Mehta',
        email: 'buyer2@datahub.com',
        password: 'Password@123',
        role: 'buyer',
        company_name: 'Infosys Ltd.'
      },
      {
        name: 'Vikram Singh',
        email: 'vikram@tcs.com',
        password: 'vikram123',
        role: 'buyer',
        company_name: 'TCS'
      }
    ];

    console.log('👥 Creating users...');
    for (const user of users) {
      // Hash the password
      const passwordHash = await bcrypt.hash(user.password, 12);

      // Find company ID
      const company = companyResults.find(c => c.name === user.company_name);
      if (!company) {
        console.error(`❌ Company not found: ${user.company_name}`);
        continue;
      }

      await db.query(`
        INSERT INTO users (name, email, password_hash, role, company_id)
        VALUES (?, ?, ?, ?, ?)
      `, [user.name, user.email, passwordHash, user.role, company.id]);

      console.log(`✓ Created user: ${user.name} (${user.role})`);
    }

    console.log('✅ Database seeded successfully!');
    console.log('\n📋 Test Credentials:');
    console.log('Broker: broker@datahub.com / Password@123');
    console.log('Client: buyer2@datahub.com / Password@123');
    console.log('Client: vikram@tcs.com / vikram123');

  } catch (error) {
    console.error('❌ Error seeding database:', error);
  } finally {
    process.exit(0);
  }
}

seedDatabase();