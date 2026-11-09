from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                KeepTogether, PageBreak, ListFlowable, ListItem)
import sys

OUT = sys.argv[1]
INK = colors.HexColor('#1f2937')
MUTED = colors.HexColor('#6b7280')
ACCENT = colors.HexColor('#0f766e')
SOFT = colors.HexColor('#ecfdf5')
WARN = colors.HexColor('#fff7ed')
WARN_EDGE = colors.HexColor('#ea580c')
CODEBG = colors.HexColor('#f3f4f6')
LINE = colors.HexColor('#d1d5db')

ss = getSampleStyleSheet()
H1 = ParagraphStyle('H1', parent=ss['Title'], fontName='Helvetica-Bold', fontSize=24, leading=29,
                    textColor=INK, alignment=0, spaceAfter=4)
SUB = ParagraphStyle('Sub', parent=ss['Normal'], fontSize=12, leading=16, textColor=MUTED, spaceAfter=14)
H2 = ParagraphStyle('H2', parent=ss['Heading2'], fontName='Helvetica-Bold', fontSize=15, leading=19,
                    textColor=ACCENT, spaceBefore=14, spaceAfter=6, keepWithNext=1)
H3 = ParagraphStyle('H3', parent=ss['Heading3'], fontName='Helvetica-Bold', fontSize=11.5, leading=15,
                    textColor=INK, spaceBefore=8, spaceAfter=3, keepWithNext=1)
P = ParagraphStyle('P', parent=ss['Normal'], fontName='Helvetica', fontSize=10.5, leading=15,
                   textColor=INK, spaceAfter=6)
SMALL = ParagraphStyle('Small', parent=P, fontSize=9.5, leading=13)
CELL = ParagraphStyle('Cell', parent=P, fontSize=9.5, leading=12.5, spaceAfter=0)
CELLB = ParagraphStyle('CellB', parent=CELL, fontName='Helvetica-Bold')
CODE = ParagraphStyle('Code', parent=P, fontName='Courier', fontSize=9, leading=12, textColor=INK,
                      spaceAfter=0)


def code(lines):
    t = Table([[Paragraph(l.replace('&', '&amp;').replace('<', '&lt;').replace(' ', '&nbsp;'), CODE)]
               for l in lines], colWidths=[6.5 * inch])
    t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), CODEBG),
                           ('LEFTPADDING', (0, 0), (-1, -1), 10), ('RIGHTPADDING', (0, 0), (-1, -1), 10),
                           ('TOPPADDING', (0, 0), (-1, -1), 1), ('BOTTOMPADDING', (0, 0), (-1, -1), 1),
                           ('TOPPADDING', (0, 0), (-1, 0), 7), ('BOTTOMPADDING', (0, -1), (-1, -1), 7)]))
    return [t, Spacer(1, 8)]


def callout(title, body, bg=SOFT, edge=ACCENT):
    t = Table([[Paragraph(f'<b>{title}</b>', P)], [Paragraph(body, SMALL)]], colWidths=[6.5 * inch])
    t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), bg),
                           ('LINEBEFORE', (0, 0), (0, -1), 3, edge),
                           ('LEFTPADDING', (0, 0), (-1, -1), 12), ('RIGHTPADDING', (0, 0), (-1, -1), 12),
                           ('TOPPADDING', (0, 0), (-1, 0), 8), ('BOTTOMPADDING', (0, -1), (-1, -1), 9),
                           ('TOPPADDING', (0, 1), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, 0), 2)]))
    return [Spacer(1, 4), t, Spacer(1, 10)]


def steps(items):
    return [ListFlowable([ListItem(Paragraph(i, P), leftIndent=16, value=n + 1) for n, i in enumerate(items)],
                         bulletType='1', bulletFontName='Helvetica-Bold', bulletColor=ACCENT, leftIndent=16),
            Spacer(1, 4)]


def bullets(items):
    return [ListFlowable([ListItem(Paragraph(i, P), leftIndent=14) for i in items],
                         bulletType='bullet', start='•', bulletColor=ACCENT, leftIndent=14), Spacer(1, 4)]


def table(rows, widths, header=True, boldfirst=True):
    data = [[Paragraph(c, CELLB if (header and r == 0) or (boldfirst and ci == 0) else CELL) for ci, c in enumerate(row)]
            for r, row in enumerate(rows)]
    t = Table(data, colWidths=[w * inch for w in widths], repeatRows=1 if header else 0)
    st = [('GRID', (0, 0), (-1, -1), 0.5, LINE), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
          ('LEFTPADDING', (0, 0), (-1, -1), 7), ('RIGHTPADDING', (0, 0), (-1, -1), 7),
          ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 6)]
    if header:
        st.append(('BACKGROUND', (0, 0), (-1, 0), SOFT))
    t.setStyle(TableStyle(st))
    return [t, Spacer(1, 10)]


def footer(c, doc):
    c.saveState()
    c.setFont('Helvetica', 8.5)
    c.setFillColor(MUTED)
    c.drawString(inch, 0.55 * inch, 'PII Shield: user guide')
    c.drawRightString(letter[0] - inch, 0.55 * inch, f'Page {doc.page}')
    c.restoreState()


s = []
s += [Paragraph('PII Shield', H1),
      Paragraph('Use Claude to analyze customer data while keeping customer names, emails and phone numbers private.', SUB)]

s += [Paragraph('What it does', H2),
      Paragraph('PII Shield is a Claude skill. Before Claude looks at your customer data, it replaces every name, email, '
                'phone number, street address and card number with a code. Claude analyzes the coded copy, and you get '
                'a file back with the real details filled in again.', P),
      Paragraph('The same customer always gets the same code, so Claude can still count unique customers, find '
                'repeat shoppers, remove duplicates and compare stores.', P)]
s += table([['Your file', 'What Claude sees'],
            ['Jane Smith', '[NAME_e5cea039]'],
            ['Jane.Smith@gmail.com', '[EMAIL_5bd1e213]'],
            ['(310) 555-0142', '[PHONE_45cfc160]'],
            ['ZIP 90501', '905xx'],
            ['"Call Jane after 5pm at 310-555-0142"', '"Call [NAME_e5cea039] after 5pm at [PHONE_45cfc160]"'],
            ['Honda Grom, Del Amo Honda, Oct 2', 'Honda Grom, Del Amo Honda, Oct 2 (unchanged)']],
           [3.0, 3.5])

s += [Paragraph('1. Install the skill', H2),
      Paragraph('Installing yourself (claude.ai)', H3)]
s += steps(['Open the <b>pii-shield.skill</b> file.',
            'Click <b>Save skill</b> on the file card. If you don’t see that button, go to '
            '<b>Settings → Capabilities → Skills</b> and upload the file.',
            'Make sure the skill is switched on in that list.'])
s += [Paragraph('Sharing with your team', H3)]
s += bullets(['<b>One person at a time:</b> send them the <b>pii-shield.skill</b> file and have them follow the steps above.',
              '<b>Whole organization:</b> an admin can add it as an organization skill so everyone gets it '
              'automatically. The exact admin menu may differ, so check your organization’s admin settings.',
              '<b>Claude Code users:</b> copy the <font face="Courier">pii-shield</font> folder into '
              '<font face="Courier">~/.claude/skills/</font>.'])

s += [Paragraph('2. Use it', H2)]
s += steps(['Start a new chat in claude.ai.',
            'Upload your customer file (CSV or Excel).',
            'Ask your question in plain English. The skill normally starts on its own when the file has customer '
            'details. To be sure, start with <b>“Use PII Shield.”</b>',
            'Read Claude’s plan for each column (see section 3) and correct anything that looks wrong.',
            'Read the findings in the chat, where customers appear as codes or totals, and download the file '
            'Claude gives you with the real names filled in.'])
s += [Paragraph('Example requests', H3)]
s += bullets(['“Use PII Shield. Here’s October’s lead export. Which stores have the most repeat shoppers, and who are they?”',
              '“Dedupe this contact list and tell me how many unique customers we really have.”',
              '“Read the call notes column and group leads by what they’re asking for. Keep customer info private.”',
              '“Break these orders down by ZIP area and month.”'])

s += [Paragraph('3. Check Claude’s plan', H2),
      Paragraph('Before analyzing anything, Claude looks at your column names (not the values) and tells you how it '
                'will handle each one. You know your data best, so speak up if something should be treated differently.', P)]
s += table([['What Claude says', 'What it means', 'Typical columns'],
            ['Keep', 'Left exactly as it is', 'Product, price, date, store, status'],
            ['Replace with a code', 'Swapped for a code that stays the same for the same person',
             'Name, email, phone, address, customer ID'],
            ['Make less exact', 'Kept, but only partly: 90501 becomes 905xx, a birth date becomes the year, '
             'an age becomes a 10-year range', 'ZIP, date of birth, age, city'],
            ['Scan', 'Free text is kept, but any personal details inside it are swapped for codes',
             'Notes, comments, transcripts'],
            ['Hide', 'Shows only that something is there, not what it is', 'Sensitive yes/no fields'],
            ['Remove', 'Left out completely', 'SSN, card number, password, any column not needed']],
           [1.35, 3.0, 2.15])
s += callout('Tip', 'Columns the plan doesn’t mention are removed automatically, so a new column can’t leak by '
                    'accident. If your analysis needs a column that was removed, ask Claude to keep it.')

s += [Paragraph('4. Get the real names back', H2),
      Paragraph('Claude writes its report using the codes, then turns it into a copy with the real names, emails and phones '
                'filled in. Claude doesn’t open that copy, so the real details never appear in the chat. Download it from the '
                'files Claude gives you at the end.', P),
      Paragraph('If you copy a coded answer out of the chat, you can ask Claude in the same chat to '
                '“restore this into a file,” or turn it back yourself (see section 5).', P)]

s += [Paragraph('5. Maximum privacy: keep the raw file on your computer', H2),
      Paragraph('When you upload a file to claude.ai, the original sits in that chat’s private workspace on Anthropic’s '
                'servers, even though Claude never reads it. If the raw file must never leave your computer, make '
                'the coded copy yourself first and upload only that. You need Node.js (version 18 or later, free from '
                'nodejs.org) and the <font face="Courier">pii-shield</font> folder.', P),
      Paragraph('Step A: let the tool suggest a plan (prints only column info, never customer details)', H3)]
s += code(['node pii-shield/scripts/cli.js inspect leads.csv \\', '    --write-policy policy.json'])
s += [Paragraph('Step B: make the coded copy', H3)]
s += code(['node pii-shield/scripts/cli.js protect leads.csv \\', '    --policy policy.json --vault vault.enc --out safe.csv'])
s += [Paragraph('Step C: upload only <b>safe.csv</b> to Claude and ask your question.', H3),
      Paragraph('Step D: turn Claude’s answer back into real names', H3),
      Paragraph('Save Claude’s answer as <b>answer.txt</b>, then run:', P)]
s += code(['node pii-shield/scripts/cli.js restore answer.txt \\', '    --vault vault.enc --out answer_with_names.txt'])
s += callout('Keep these two files private',
             '<b>vault.enc</b> is the encrypted list that matches codes to real details. Your secret key is created automatically '
             'the first time you run the tool and stored in <font face="Courier">~/.pii-shield/key</font>. Never email or upload '
             'either one.', WARN, WARN_EDGE)

s += [KeepTogether([Paragraph('6. Keys and teammates', H2)] + bullets(['Everyone gets their own secret key automatically. Nothing to set up.',
              'The same key always gives the same customer the same code, so separate files from the same person can be '
              'combined and compared.',
              'Two people only need the same key if one of them must turn the other’s codes back into names. Share it through a '
              'password manager, <b>never</b> by email, Slack or chat.',
              'Without the key, nobody can work out who a code belongs to, including Claude and Anthropic.']))]

s += [Paragraph('7. What it catches, and what it doesn’t', H2)]
s += table([['Caught', 'Not caught'],
            ['Names from name columns, even when they appear in notes<br/>'
             'Emails<br/>US and international phone numbers<br/>Card numbers (verified)<br/>'
             'Social Security numbers<br/>US street addresses<br/>IP addresses<br/>'
             '“Mr./Mrs./Ms./Dr. Name” in text',
             'A first name in notes that isn’t in a name column and has no Mr./Mrs. in front, e.g. '
             '“my brother Mike called”<br/><br/>Details you type straight into the chat (anything you type is visible '
             'to Claude)']],
           [3.25, 3.25], boldfirst=False)
s += callout('If notes are sensitive',
             'If your analysis doesn’t need a free-text column, ask Claude to <b>remove</b> or <b>hide</b> it. '
             'That’s the safest choice for notes that might mention family members or other people.', WARN, WARN_EDGE)
s += [Paragraph('Coded data still counts as personal data under privacy laws like GDPR and CCPA. PII Shield greatly '
                'limits what Claude sees, but it doesn’t replace your company’s data agreements and policies.', SMALL)]

s += [Paragraph('8. Troubleshooting', H2)]
s += table([['If this happens', 'Do this'],
            ['The skill didn’t start', 'Start your message with “Use PII Shield.” Check that the skill is '
             'switched on in Settings → Capabilities → Skills.'],
            ['Claude showed raw customer rows', 'Stop and tell Claude: “Don’t read the raw file. Use PII Shield.” '
             'Start a fresh chat if you want a clean record.'],
            ['A “Blocked: still contains PII” message', 'That’s the safety check working: nothing was sent. '
             'Claude will name the type of detail found (e.g. PHONE). Have it tighten that column’s setting and try again.'],
            ['A column was handled wrong', 'Tell Claude, e.g. “Keep the vehicle column as is” or '
             '“Remove the notes column.”'],
            ['You need something about a hidden value (e.g. most common email domain)',
             'Ask Claude to add a separate column with just the domain before coding, so the domain is kept but the email isn’t.'],
            ['Excel file with several tabs', 'Tell Claude which tab to use, or save that tab as a CSV first.']],
           [2.2, 4.3])

doc = SimpleDocTemplate(OUT, pagesize=letter, leftMargin=inch, rightMargin=inch, topMargin=0.75 * inch,
                        bottomMargin=0.8 * inch, title='PII Shield: user guide', author='Revv Marketing')
doc.build(s, onFirstPage=footer, onLaterPages=footer)
print('wrote', OUT)
