/* ============================================================
   bioSafe — Supabase Client (Cloud Template + Mobile Biometrics)
   ============================================================ */

const SUPABASE_URL      = 'https://wdqyrptwddlyhejaykmr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_5_kwnEO80DvDLSsSHvwkGQ_gdLv1dC4';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ---------- Helper: SHA-256 hash ---------- */
async function hashPassword(password) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(password)
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ============================================================
   API Layer
   ============================================================ */
const SB = {

  /* ---------- ADMIN ---------- */
  admin: {
    async login({ username, password }) {
      const hash = await hashPassword(password);
      const { data, error } = await supabaseClient
        .from('admins')
        .select('username')
        .eq('username', username)
        .eq('password', hash)
        .maybeSingle();

      if (error) return { ok: false, error: error.message };
      if (!data)  return { ok: false, error: 'Invalid username or password' };
      return { ok: true, admin: { username: data.username } };
    },

    async registerPatient(payload) {
      const { data: dup } = await supabaseClient
        .from('patients').select('id').eq('national_id', payload.nationalId).maybeSingle();
      if (dup) return { ok: false, error: 'A patient with this National ID already exists' };

      const insertData = {
        national_id:   payload.nationalId,
        password:      await hashPassword(payload.password),
        full_name:     payload.fullName,
        email:         payload.email || null,
        phone:         payload.phone || null,
        blood_type:    payload.bloodType || null,
        date_of_birth: payload.dateOfBirth || null,
        address:       payload.address || null
      };

      if (payload.isMobile) {
        insertData.mobile_credential_id = payload.credentialId;
      } else {
        insertData.credential_id = payload.credentialId;
      }

      const { data, error } = await supabaseClient.from('patients').insert(insertData).select('id').single();

      if (error) return { ok: false, error: error.message };
      return { ok: true, message: 'Patient registered successfully', id: data.id };
    },

    async registerDoctor(payload) {
      const { data: dup } = await supabaseClient
        .from('doctors').select('id').eq('national_id', payload.nationalId).maybeSingle();
      if (dup) return { ok: false, error: 'A doctor with this National ID already exists' };

      const insertData = {
        national_id:    payload.nationalId,
        password:       await hashPassword(payload.password),
        full_name:      payload.fullName,
        specialization: payload.specialization || null,
        hospital:       payload.hospital || null,
        email:          payload.email || null
      };

      if (payload.isMobile) {
        insertData.mobile_credential_id = payload.credentialId;
      } else {
        insertData.credential_id = payload.credentialId;
      }

      const { data, error } = await supabaseClient.from('doctors').insert(insertData).select('id').single();

      if (error) return { ok: false, error: error.message };
      return { ok: true, message: 'Doctor registered successfully', id: data.id };
    },

    async listPatients() {
      const { data, error } = await supabaseClient
        .from('patients')
        .select('id,national_id,full_name,email,phone,blood_type,date_of_birth,address,created_at')
        .order('created_at', { ascending: false });
      if (error) return { ok: false, error: error.message };
      return { ok: true, data: data.map(p => ({
        nationalId: p.national_id, fullName: p.full_name,
        email: p.email, phone: p.phone, bloodType: p.blood_type,
        dateOfBirth: p.date_of_birth, address: p.address
      })) };
    },

    async listDoctors() {
      const { data, error } = await supabaseClient
        .from('doctors')
        .select('id,national_id,full_name,specialization,hospital,email,created_at')
        .order('created_at', { ascending: false });
      if (error) return { ok: false, error: error.message };
      return { ok: true, data: data.map(d => ({
        nationalId: d.national_id, fullName: d.full_name,
        specialization: d.specialization, hospital: d.hospital, email: d.email
      })) };
    }
  },

  /* ---------- PATIENT ---------- */
  patient: {
    async login({ nationalId, password }) {
      const hash = await hashPassword(password);
      const { data, error } = await supabaseClient
        .from('patients').select('*')
        .eq('national_id', nationalId).eq('password', hash)
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!data)  return { ok: false, error: 'Invalid National ID or password' };
      return { ok: true, user: mapPatient(data) };
    },

    async loginBiometric(credentialId, isMobile = false) {
      const column = isMobile ? 'mobile_credential_id' : 'credential_id';
      const { data, error } = await supabaseClient
        .from('patients').select('*')
        .eq(column, credentialId).maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!data)  return { ok: false, error: 'No account linked to this fingerprint' };
      return { ok: true, user: mapPatient(data) };
    },

    async linkMobileFingerprint(nationalId, mobileCredentialId) {
      const { error } = await supabaseClient
        .from('patients')
        .update({ mobile_credential_id: mobileCredentialId })
        .eq('national_id', nationalId);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    },

    async history(nationalId) {
      const { data, error } = await supabaseClient
        .from('medical_records').select('*')
        .eq('patient_national_id', nationalId)
        .order('visit_date', { ascending: false });
      if (error) return { ok: false, error: error.message };
      return { ok: true, data: data.map(mapRecord) };
    }
  },

  /* ---------- DOCTOR ---------- */
  doctor: {
    async login({ nationalId, password }) {
      const hash = await hashPassword(password);
      const { data, error } = await supabaseClient
        .from('doctors').select('*')
        .eq('national_id', nationalId).eq('password', hash)
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!data)  return { ok: false, error: 'Invalid National ID or password' };
      return { ok: true, doctor: mapDoctor(data) };
    },

    async loginBiometric(credentialId, isMobile = false) {
      const column = isMobile ? 'mobile_credential_id' : 'credential_id';
      const { data, error } = await supabaseClient
        .from('doctors').select('*')
        .eq(column, credentialId).maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!data)  return { ok: false, error: 'No account linked to this fingerprint' };
      return { ok: true, doctor: mapDoctor(data) };
    },

    async linkMobileFingerprint(nationalId, mobileCredentialId) {
      const { error } = await supabaseClient
        .from('doctors')
        .update({ mobile_credential_id: mobileCredentialId })
        .eq('national_id', nationalId);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    },

    async registerPatient(payload) {
      const { data: dup } = await supabaseClient
        .from('patients').select('id').eq('national_id', payload.nationalId).maybeSingle();
      if (dup) return { ok: false, error: 'A patient with this National ID already exists' };

      const insertData = {
        national_id:   payload.nationalId,
        password:      await hashPassword(payload.password),
        full_name:     payload.fullName,
        email:         payload.email || null,
        phone:         payload.phone || null,
        blood_type:    payload.bloodType || null,
        date_of_birth: payload.dateOfBirth || null,
        address:       payload.address || null
      };

      if (payload.isMobile) {
        insertData.mobile_credential_id = payload.credentialId;
      } else {
        insertData.credential_id = payload.credentialId;
      }

      const { data, error } = await supabaseClient.from('patients').insert(insertData).select('id').single();
      if (error) return { ok: false, error: error.message };
      return { ok: true, message: 'Patient added successfully', id: data.id };
    },

    async getPatient(nationalId) {
      const { data, error } = await supabaseClient
        .from('patients')
        .select('id,national_id,full_name,email,phone,blood_type,date_of_birth,address')
        .eq('national_id', nationalId).maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!data)  return { ok: false, error: 'Patient not found' };
      return { ok: true, patient: mapPatient(data) };
    },

    async addRecord(payload) {
      const { data: pat } = await supabaseClient
        .from('patients').select('id').eq('national_id', payload.patientNationalId).maybeSingle();
      if (!pat) return { ok: false, error: 'Patient not found' };

      const { data, error } = await supabaseClient.from('medical_records').insert({
        patient_national_id: payload.patientNationalId,
        doctor_national_id:  payload.doctorNationalId,
        doctor_name:         payload.doctorName || null,
        hospital:            payload.hospital || null,
        diagnosis:           payload.diagnosis,
        treatment:           payload.treatment || null,
        medications:         payload.medications || null,
        notes:               payload.notes || null,
        visit_date:          payload.visitDate || new Date().toISOString()
      }).select().single();
      if (error) return { ok: false, error: error.message };
      return { ok: true, message: 'Medical record created', record: mapRecord(data) };
    },

    async myRecords(doctorNationalId) {
      const { data, error } = await supabaseClient
        .from('medical_records').select('*')
        .eq('doctor_national_id', doctorNationalId)
        .order('visit_date', { ascending: false });
      if (error) return { ok: false, error: error.message };
      return { ok: true, data: data.map(mapRecord) };
    }
  }
};

/* ---------- mappers (snake_case → camelCase) ---------- */
function mapPatient(p) {
  return {
    nationalId:  p.national_id,
    fullName:    p.full_name,
    email:       p.email,
    phone:       p.phone,
    bloodType:   p.blood_type,
    dateOfBirth: p.date_of_birth,
    address:     p.address
  };
}
function mapDoctor(d) {
  return {
    nationalId:     d.national_id,
    fullName:       d.full_name,
    specialization: d.specialization,
    hospital:       d.hospital,
    email:          d.email
  };
}
function mapRecord(r) {
  return {
    patientNationalId: r.patient_national_id,
    doctorNationalId:  r.doctor_national_id,
    doctorName:        r.doctor_name,
    hospital:          r.hospital,
    diagnosis:         r.diagnosis,
    treatment:         r.treatment,
    medications:       r.medications,
    notes:             r.notes,
    visitDate:         r.visit_date
  };
}