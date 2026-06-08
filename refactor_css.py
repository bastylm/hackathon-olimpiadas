import re

with open('public/styles.css', 'r', encoding='utf-8') as f:
    content = f.read()

admin_grid_css = '''\.admin-grid \{
  display: grid;
  grid-template-columns: 330px minmax\(360px, 1fr\) 380px;
  gap: 16px;
  align-items: start;
\}'''

wizard_css = '''.wizard-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 24px;
  box-shadow: 0 16px 40px rgba(16, 24, 40, 0.08);
  width: 100%;
}

.wizard-progress {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
  padding: 0 10%;
}

.wizard-step-line {
  flex: 1;
  height: 2px;
  background: var(--line);
  margin: 0 16px;
}

.wizard-step-indicator {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--muted);
}

.wizard-step-indicator .step-num {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--bg);
  border: 2px solid var(--line);
  font-weight: bold;
}

.wizard-step-indicator.active {
  color: var(--accent);
}

.wizard-step-indicator.active .step-num {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.wizard-step-indicator.completed {
  color: var(--accent-dark);
}

.wizard-step-indicator.completed .step-num {
  background: var(--accent-dark);
  color: #fff;
  border-color: var(--accent-dark);
}

.wizard-step-indicator .step-label {
  font-size: 13px;
  font-weight: 700;
}

.wizard-step-content {
  width: 100%;
}

.wizard-step-content > .panel {
  border: none;
  box-shadow: none;
  padding: 0;
  background: transparent;
}

.wizard-navigation {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}'''

content = re.sub(admin_grid_css, wizard_css, content)

content = re.sub(r'\.admin-grid,\s*\.projection-grid', '.projection-grid', content)

with open('public/styles.css', 'w', encoding='utf-8') as f:
    f.write(content)
