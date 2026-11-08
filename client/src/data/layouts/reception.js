// Reception – Patient Registration (sample layout, awaiting hospital approval)
//
// Plain HTML that the TipTap editor understands: headings, paragraphs, bold, underline and tables.
//   <th> = a shaded label cell, <td> = the value next to it.
//   {{name}} = a value that is not filled in yet. The AI replaces it only when the value is given.
// No hospital logo, no real patient data.

const row = (l1, v1, l2, v2) =>
  `<tr><th><p>${l1}</p></th><td><p>{{${v1}}}</p></td><th><p>${l2}</p></th><td><p>{{${v2}}}</p></td></tr>`;

export const RECEPTION_REGISTRATION = `
<p style="text-align: center"><strong>{{hospital_name}}</strong></p>
<h1 style="text-align: center"><u>PATIENT REGISTRATION FORM</u></h1>

<h3>PATIENT DETAILS</h3>
<table><tbody>
${row('Patient Name', 'patient_name', 'Registration No', 'registration_no')}
${row('Date of Birth', 'date_of_birth', 'Age', 'age')}
${row('Gender', 'gender', 'Blood Group', 'blood_group')}
</tbody></table>

<h3>CONTACT DETAILS</h3>
<table><tbody>
${row('Mobile No', 'mobile_no', 'Email', 'email')}
<tr><th><p>Address</p></th><td><p>{{address}}</p></td><th><p>PIN Code</p></th><td><p>{{pin_code}}</p></td></tr>
</tbody></table>

<h3>EMERGENCY CONTACT</h3>
<table><tbody>
${row('Contact Name', 'emergency_contact_name', 'Relationship', 'emergency_contact_relationship')}
${row('Contact Number', 'emergency_contact_number', 'Contact Address', 'emergency_contact_address')}
</tbody></table>

<h3>IDENTIFICATION</h3>
<table><tbody>
${row('ID Type', 'id_type', 'ID Number', 'id_number')}
</tbody></table>

<h3>VISIT DETAILS</h3>
<table><tbody>
${row('Visit Date', 'visit_date', 'Visit Type', 'visit_type')}
${row('Department', 'department', 'Consultant', 'consultant_name')}
</tbody></table>

<h3>REGISTRATION</h3>
<table><tbody>
${row('Registration Date', 'registration_date', 'Registered By', 'registered_by')}
</tbody></table>
<p><strong>Remarks:</strong> {{remarks}}</p>

<hr>
<h3>PATIENT DECLARATION</h3>
<p>{{declaration_text}}</p>
<p><strong>Patient / Guardian Name:</strong> {{declarant_name}}</p>
<p><strong>Relationship to Patient:</strong> {{declarant_relationship}}</p>
<p><strong>Signature:</strong> {{patient_signature}}</p>
<p><strong>Date:</strong> {{declaration_date}}</p>
`.trim();
