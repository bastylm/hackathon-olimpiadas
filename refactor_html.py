import re

with open('public/admin.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace <div class="admin-grid"> with <div class="wizard-container"> and add progress bar
grid_start = '<div class=\"admin-grid\">'
wizard_header = '''<div class=\"wizard-container\">
          <div class=\"wizard-progress\">
            <div class=\"wizard-step-indicator active\" data-indicator=\"1\">
              <span class=\"step-num\">1</span>
              <span class=\"step-label\">Configuración</span>
            </div>
            <div class=\"wizard-step-line\"></div>
            <div class=\"wizard-step-indicator\" data-indicator=\"2\">
              <span class=\"step-num\">2</span>
              <span class=\"step-label\">Selección de Preguntas</span>
            </div>
            <div class=\"wizard-step-line\"></div>
            <div class=\"wizard-step-indicator\" data-indicator=\"3\">
              <span class=\"step-num\">3</span>
              <span class=\"step-label\">Control en Vivo</span>
            </div>
          </div>'''

content = content.replace(grid_start, wizard_header)

# Wrap <section class="panel setup">
content = content.replace('<section class=\"panel setup\">', '<div class=\"wizard-step-content active\" data-step=\"1\">\n            <section class=\"panel setup\">')
# Add closing </div> for step 1 before <section class="panel questions">
content = content.replace('</section>\\n\\n          <section class=\"panel questions\">', '</section>\\n          </div>\\n\\n          <div class=\"wizard-step-content hidden\" data-step=\"2\">\\n            <section class=\"panel questions\">')
content = re.sub(r'</section>\s*<section class="panel questions">', '</section>\\n          </div>\\n\\n          <div class="wizard-step-content hidden" data-step="2">\\n            <section class="panel questions">', content)

# Wrap <section class="panel live">
content = re.sub(r'</section>\s*<section class="panel live">', '</section>\\n          </div>\\n\\n          <div class="wizard-step-content hidden" data-step="3">\\n            <section class="panel live">', content)

# Find the closing </div> of admin-grid (which is now wizard-container) and add navigation inside it
# The closing </div> is just before <section class="panel session-history"
wizard_footer = '''</section>
          </div>
          <div class="wizard-navigation">
            <button id="wizardPrev" type="button" class="hidden">Anterior</button>
            <button id="wizardNext" class="primary" type="button">Siguiente</button>
          </div>
        </div>'''
content = re.sub(r'</section>\s*</div>\s*<section class="panel session-history"', wizard_footer + '\\n\\n        <section class="panel session-history"', content)

with open('public/admin.html', 'w', encoding='utf-8') as f:
    f.write(content)
