/**
 * Database Seed Script
 *
 * Creates a working development dataset:
 *   - 1 admin user
 *   - 5 regular users with skills, interests, and preferred roles
 *   - 1 active hackathon event
 *   - 2 registered participants with full profiles
 *   - 1 manual team (forming) with the first user as owner
 *
 * Run with: npm run db:seed
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient({ log: ['warn', 'error'] });

async function main() {
  console.log('🌱 Starting database seed...');

  // ─── Clean existing data ─────────────────────────────────────────────────
  await prisma.$transaction([
    prisma.notification.deleteMany(),
    prisma.chatMessage.deleteMany(),
    prisma.requestInvitation.deleteMany(),
    prisma.provisionalTeamMember.deleteMany(),
    prisma.provisionalTeam.deleteMany(),
    prisma.teamMember.deleteMany(),
    prisma.teamRequirement.deleteMany(),
    prisma.matchingRound.deleteMany(),
    prisma.eventParticipant.deleteMany(),
    prisma.team.deleteMany(),
    prisma.chatRoom.deleteMany(),
    prisma.eventRequiredSkill.deleteMany(),
    prisma.eventRequiredRole.deleteMany(),
    prisma.event.deleteMany(),
    prisma.userSkill.deleteMany(),
    prisma.userInterest.deleteMany(),
    prisma.userPreferredRole.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.user.deleteMany(),
  ]);

  console.log('🗑️  Cleared existing data.');

  // ─── Users ───────────────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash('Password1!', 12);

  const admin = await prisma.user.create({
    data: {
      email: 'admin@omada.dev',
      passwordHash,
      displayName: 'Admin User',
      isAdmin: true,
      isVerified: true,
    },
  });

  const alice = await prisma.user.create({
    data: {
      email: 'alice@omada.dev',
      passwordHash,
      displayName: 'Alice Chen',
      bio: 'Full-stack developer with a passion for React and Node.js.',
      isVerified: true,
      skills: {
        create: [
          { skillName: 'react', skillDisplay: 'React', proficiency: 5 },
          { skillName: 'typescript', skillDisplay: 'TypeScript', proficiency: 4 },
          { skillName: 'nodejs', skillDisplay: 'Node.js', proficiency: 4 },
          { skillName: 'postgresql', skillDisplay: 'PostgreSQL', proficiency: 3 },
        ],
      },
      interests: {
        create: [
          { interestName: 'web_development', interestDisplay: 'Web Development' },
          { interestName: 'ai_ml', interestDisplay: 'AI/ML' },
          { interestName: 'open_source', interestDisplay: 'Open Source' },
        ],
      },
      preferredRoles: {
        create: [
          { roleName: 'frontend_developer', roleDisplay: 'Frontend Developer', priority: 1 },
          { roleName: 'backend_developer', roleDisplay: 'Backend Developer', priority: 2 },
        ],
      },
    },
  });

  const bob = await prisma.user.create({
    data: {
      email: 'bob@omada.dev',
      passwordHash,
      displayName: 'Bob Patel',
      bio: 'ML engineer specializing in NLP and computer vision.',
      isVerified: true,
      skills: {
        create: [
          { skillName: 'python', skillDisplay: 'Python', proficiency: 5 },
          { skillName: 'pytorch', skillDisplay: 'PyTorch', proficiency: 4 },
          { skillName: 'ml', skillDisplay: 'Machine Learning', proficiency: 5 },
          { skillName: 'nlp', skillDisplay: 'NLP', proficiency: 4 },
          { skillName: 'docker', skillDisplay: 'Docker', proficiency: 3 },
        ],
      },
      interests: {
        create: [
          { interestName: 'ai_ml', interestDisplay: 'AI/ML' },
          { interestName: 'research', interestDisplay: 'Research' },
          { interestName: 'data_science', interestDisplay: 'Data Science' },
        ],
      },
      preferredRoles: {
        create: [
          { roleName: 'ml_engineer', roleDisplay: 'ML Engineer', priority: 1 },
          { roleName: 'researcher', roleDisplay: 'Researcher', priority: 2 },
        ],
      },
    },
  });

  const carol = await prisma.user.create({
    data: {
      email: 'carol@omada.dev',
      passwordHash,
      displayName: 'Carol Zhang',
      bio: 'UI/UX designer who codes. Figma expert.',
      isVerified: true,
      skills: {
        create: [
          { skillName: 'figma', skillDisplay: 'Figma', proficiency: 5 },
          { skillName: 'ui_ux', skillDisplay: 'UI/UX Design', proficiency: 5 },
          { skillName: 'css', skillDisplay: 'CSS', proficiency: 4 },
          { skillName: 'react', skillDisplay: 'React', proficiency: 3 },
        ],
      },
      interests: {
        create: [
          { interestName: 'design', interestDisplay: 'Design' },
          { interestName: 'web_development', interestDisplay: 'Web Development' },
          { interestName: 'ux_research', interestDisplay: 'UX Research' },
        ],
      },
      preferredRoles: {
        create: [
          { roleName: 'ui_ux_designer', roleDisplay: 'UI/UX Designer', priority: 1 },
          { roleName: 'frontend_developer', roleDisplay: 'Frontend Developer', priority: 2 },
        ],
      },
    },
  });

  const dave = await prisma.user.create({
    data: {
      email: 'dave@omada.dev',
      passwordHash,
      displayName: 'Dave Kumar',
      bio: 'DevOps and cloud infrastructure specialist.',
      isVerified: true,
      skills: {
        create: [
          { skillName: 'kubernetes', skillDisplay: 'Kubernetes', proficiency: 4 },
          { skillName: 'docker', skillDisplay: 'Docker', proficiency: 5 },
          { skillName: 'aws', skillDisplay: 'AWS', proficiency: 4 },
          { skillName: 'terraform', skillDisplay: 'Terraform', proficiency: 3 },
          { skillName: 'python', skillDisplay: 'Python', proficiency: 3 },
        ],
      },
      interests: {
        create: [
          { interestName: 'devops', interestDisplay: 'DevOps' },
          { interestName: 'cloud', interestDisplay: 'Cloud Computing' },
          { interestName: 'automation', interestDisplay: 'Automation' },
        ],
      },
      preferredRoles: {
        create: [
          { roleName: 'devops_engineer', roleDisplay: 'DevOps Engineer', priority: 1 },
          { roleName: 'backend_developer', roleDisplay: 'Backend Developer', priority: 2 },
        ],
      },
    },
  });

  const eve = await prisma.user.create({
    data: {
      email: 'eve@omada.dev',
      passwordHash,
      displayName: 'Eve Nakamura',
      bio: 'Backend developer with expertise in distributed systems.',
      isVerified: true,
      skills: {
        create: [
          { skillName: 'go', skillDisplay: 'Go', proficiency: 5 },
          { skillName: 'postgresql', skillDisplay: 'PostgreSQL', proficiency: 4 },
          { skillName: 'redis', skillDisplay: 'Redis', proficiency: 4 },
          { skillName: 'kubernetes', skillDisplay: 'Kubernetes', proficiency: 3 },
        ],
      },
      interests: {
        create: [
          { interestName: 'distributed_systems', interestDisplay: 'Distributed Systems' },
          { interestName: 'open_source', interestDisplay: 'Open Source' },
          { interestName: 'performance', interestDisplay: 'Performance Engineering' },
        ],
      },
      preferredRoles: {
        create: [
          { roleName: 'backend_developer', roleDisplay: 'Backend Developer', priority: 1 },
          { roleName: 'devops_engineer', roleDisplay: 'DevOps Engineer', priority: 2 },
        ],
      },
    },
  });

  console.log('👤 Created 6 users (1 admin, 5 regular).');

  // ─── Event ───────────────────────────────────────────────────────────────
  const event = await prisma.event.create({
    data: {
      organizerId: admin.id,
      name: 'Omada Hackathon 2026',
      description: 'Build innovative solutions using AI, web, and cloud technologies. Teams of any size welcome!',
      eventType: 'hackathon',
      status: 'registration_open',
      registrationOpens: new Date('2026-09-01'),
      registrationCloses: new Date('2026-10-15'),
      eventStarts: new Date('2026-10-20'),
      eventEnds: new Date('2026-10-22'),
      matchmakingEnabled: true,
      autoMatchTimeoutHrs: 48,
      requiredSkills: {
        create: [
          { skillName: 'python', constraintType: 'soft' },
          { skillName: 'react', constraintType: 'soft' },
          { skillName: 'ml', constraintType: 'soft' },
        ],
      },
      requiredRoles: {
        create: [
          { roleName: 'backend_developer', constraintType: 'soft' },
          { roleName: 'frontend_developer', constraintType: 'soft' },
          { roleName: 'ml_engineer', constraintType: 'soft' },
        ],
      },
    },
  });

  console.log('📅 Created event:', event.name);

  // ─── Event Participants ───────────────────────────────────────────────────
  await prisma.eventParticipant.create({
    data: { eventId: event.id, userId: alice.id, status: 'looking_for_team' },
  });
  await prisma.eventParticipant.create({
    data: { eventId: event.id, userId: bob.id, status: 'looking_for_team' },
  });
  await prisma.eventParticipant.create({
    data: { eventId: event.id, userId: carol.id, status: 'looking_for_team' },
  });
  await prisma.eventParticipant.create({
    data: { eventId: event.id, userId: dave.id, status: 'looking_for_team' },
  });
  await prisma.eventParticipant.create({
    data: { eventId: event.id, userId: eve.id, status: 'looking_for_team' },
  });

  console.log('🎟️  Registered 5 participants for event.');

  // ─── Team (manual, forming) ───────────────────────────────────────────────
  const chatRoom = await prisma.chatRoom.create({
    data: { roomType: 'permanent', status: 'active' },
  });

  const team = await prisma.team.create({
    data: {
      eventId: event.id,
      name: 'AI Vanguard',
      description: 'Building an AI-powered team collaboration tool.',
      ownerId: alice.id,
      status: 'forming',
      source: 'manual',
      chatRoomId: chatRoom.id,
      projectIdea: 'An AI assistant that helps teams discover complementary members.',
      requirements: {
        create: [
          { requirementType: 'skill', name: 'ml', priority: 'must_have' },
          { requirementType: 'skill', name: 'react', priority: 'nice_to_have' },
          { requirementType: 'role', name: 'ml_engineer', priority: 'must_have' },
        ],
      },
    },
  });

  await prisma.teamMember.create({
    data: { teamId: team.id, userId: alice.id, roleInTeam: 'owner' },
  });

  await prisma.eventParticipant.update({
    where: { eventId_userId: { eventId: event.id, userId: alice.id } },
    data: { status: 'in_forming_team', teamId: team.id },
  });

  console.log('👥 Created team:', team.name, '(Alice is owner, forming)');

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log('\n✅ Seed complete!\n');
  console.log('Test credentials (all use password: Password1!):');
  console.log('  Admin: admin@omada.dev');
  console.log('  Alice: alice@omada.dev  (in forming team: AI Vanguard)');
  console.log('  Bob:   bob@omada.dev    (looking for team)');
  console.log('  Carol: carol@omada.dev  (looking for team)');
  console.log('  Dave:  dave@omada.dev   (looking for team)');
  console.log('  Eve:   eve@omada.dev    (looking for team)');
  console.log(`\n  Event ID: ${event.id}`);
  console.log(`  Team ID:  ${team.id}`);
  console.log(`  Chat Room ID: ${chatRoom.id}`);
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
