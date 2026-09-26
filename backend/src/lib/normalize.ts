/**
 * Skill normalizer — maps user-entered skill strings to a canonical name.
 * Phase 2 will replace this with AI-powered normalization.
 */

const NORMALIZATION_MAP: Record<string, string> = {
  // Frontend
  'react': 'react', 'react.js': 'react', 'reactjs': 'react',
  'vue': 'vue', 'vue.js': 'vue', 'vuejs': 'vue',
  'angular': 'angular', 'angularjs': 'angular',
  'svelte': 'svelte',
  'next.js': 'nextjs', 'nextjs': 'nextjs', 'next': 'nextjs',
  'nuxt': 'nuxtjs', 'nuxt.js': 'nuxtjs',
  'typescript': 'typescript', 'ts': 'typescript',
  'javascript': 'javascript', 'js': 'javascript',
  'html': 'html', 'html5': 'html',
  'css': 'css', 'css3': 'css',
  'sass': 'sass', 'scss': 'sass',
  'tailwind': 'tailwindcss', 'tailwindcss': 'tailwindcss',
  'figma': 'figma',
  'ui/ux': 'ui_ux', 'ux': 'ui_ux', 'ui design': 'ui_ux',
  // Backend
  'node': 'nodejs', 'node.js': 'nodejs', 'nodejs': 'nodejs',
  'express': 'express', 'express.js': 'express',
  'fastapi': 'fastapi',
  'django': 'django',
  'flask': 'flask',
  'spring': 'spring', 'spring boot': 'spring_boot', 'springboot': 'spring_boot',
  'golang': 'go', 'go': 'go',
  'rust': 'rust',
  'python': 'python',
  'java': 'java',
  'c++': 'cpp', 'cpp': 'cpp',
  'c#': 'csharp', 'csharp': 'csharp',
  'php': 'php',
  'ruby': 'ruby', 'rails': 'ruby_on_rails', 'ruby on rails': 'ruby_on_rails',
  // Data / ML
  'machine learning': 'ml', 'ml': 'ml',
  'deep learning': 'deep_learning',
  'pytorch': 'pytorch', 'torch': 'pytorch',
  'tensorflow': 'tensorflow', 'tf': 'tensorflow',
  'sklearn': 'scikit_learn', 'scikit-learn': 'scikit_learn', 'scikit_learn': 'scikit_learn',
  'pandas': 'pandas',
  'numpy': 'numpy',
  'data science': 'data_science',
  'data analysis': 'data_analysis',
  'nlp': 'nlp', 'natural language processing': 'nlp',
  'computer vision': 'computer_vision', 'cv': 'computer_vision',
  // Databases
  'postgresql': 'postgresql', 'postgres': 'postgresql',
  'mysql': 'mysql',
  'mongodb': 'mongodb', 'mongo': 'mongodb',
  'redis': 'redis',
  'sqlite': 'sqlite',
  'sql': 'sql',
  // DevOps / Cloud
  'docker': 'docker',
  'kubernetes': 'kubernetes', 'k8s': 'kubernetes',
  'aws': 'aws',
  'gcp': 'gcp', 'google cloud': 'gcp',
  'azure': 'azure',
  'ci/cd': 'cicd', 'github actions': 'github_actions',
  'terraform': 'terraform',
  'linux': 'linux',
  // Other
  'git': 'git',
  'github': 'github',
  'research': 'research',
  'agile': 'agile', 'scrum': 'scrum',
};

export function normalizeSkill(raw: string): string {
  const key = raw.toLowerCase().trim();
  return NORMALIZATION_MAP[key] ?? key.replace(/[^a-z0-9_]/g, '_').replace(/__+/g, '_');
}

export function normalizeInterest(raw: string): string {
  return raw.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_').replace(/__+/g, '_');
}

export function normalizeRole(raw: string): string {
  return raw.toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}
