import re

with open('public/styles.css', 'r', encoding='utf-8') as f:
    content = f.read()

new_btn_css = '''.wizard-navigation {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 32px;
  padding-top: 24px;
  border-top: 1px solid var(--line);
}

.wizard-navigation button {
  padding: 12px 24px;
  font-size: 1rem;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.wizard-navigation #wizardPrev {
  background: var(--line);
  color: var(--ink);
  border: none;
}
.wizard-navigation #wizardPrev:hover {
  background: #d1c4e9;
}

.wizard-navigation #wizardNext {
  background: var(--accent);
  color: #fff;
  border: none;
  font-weight: bold;
}
.wizard-navigation #wizardNext:hover {
  background: var(--accent-dark);
}'''

content = content.replace('.wizard-navigation {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  margin-top: 24px;\n  padding-top: 16px;\n  border-top: 1px solid var(--line);\n}', new_btn_css)

with open('public/styles.css', 'w', encoding='utf-8') as f:
    f.write(content)
