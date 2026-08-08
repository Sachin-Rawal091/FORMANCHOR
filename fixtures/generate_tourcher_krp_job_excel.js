import XLSX from '@e965/xlsx';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Complete dataset exactly matching form fields in tests/tourcher_krp_job.html
const combinedData = [
  {
    "Full legal name": "Aarav Sharma",
    "Candidate Name": "Aarav Sharma",
    "Applicant full legal name": "Aarav Sharma",
    "Email address": "aarav.sharma@example.com",
    "Email Address": "aarav.sharma@example.com",
    "Mobile number": "+91 98765 43210",
    "Date of birth": "15/08/1998",
    "Date of Birth": "15/08/1998",
    "Student Enrollment / Reg No.": "KRP-2026-1001",
    "Social Category": "General",
    "Aadhaar Number (12 digits)": "123456789012",
    "National ID / Aadhaar number": "123456789012",
    "Bank Account Number": "987654321012",
    "Bank IFSC Code": "SBIN0001234",
    "Scholarship Scheme": "Post-Matric Scholarship",
    "Claim Submission Date": "20/09/2026",
    "Claim filing date": "2026-09-20",
    "Expected Joining Date": "01/10/2026",
    "Nationality": "Indian",
    "Preferred Work Location": "Bangalore"
  },
  {
    "Full legal name": "Priya Patel",
    "Candidate Name": "Priya Patel",
    "Applicant full legal name": "Priya Patel",
    "Email address": "priya.patel@example.com",
    "Email Address": "priya.patel@example.com",
    "Mobile number": "+91 91234 56789",
    "Date of birth": "24/03/1995",
    "Date of Birth": "24/03/1995",
    "Student Enrollment / Reg No.": "KRP-2026-1002",
    "Social Category": "OBC",
    "Aadhaar Number (12 digits)": "234567890123",
    "National ID / Aadhaar number": "234567890123",
    "Bank Account Number": "876543210123",
    "Bank IFSC Code": "HDFC0004321",
    "Scholarship Scheme": "Merit-cum-Means Assistance",
    "Claim Submission Date": "22/09/2026",
    "Claim filing date": "2026-09-22",
    "Expected Joining Date": "15/10/2026",
    "Nationality": "Indian",
    "Preferred Work Location": "Mumbai"
  },
  {
    "Full legal name": "Rohan Verma",
    "Candidate Name": "Rohan Verma",
    "Applicant full legal name": "Rohan Verma",
    "Email address": "rohan.verma@example.com",
    "Email Address": "rohan.verma@example.com",
    "Mobile number": "+91 99887 76655",
    "Date of birth": "10/12/1997",
    "Date of Birth": "10/12/1997",
    "Student Enrollment / Reg No.": "KRP-2026-1003",
    "Social Category": "SC",
    "Aadhaar Number (12 digits)": "345678901234",
    "National ID / Aadhaar number": "345678901234",
    "Bank Account Number": "765432101234",
    "Bank IFSC Code": "ICIC0009876",
    "Scholarship Scheme": "Pre-Matric Scholarship",
    "Claim Submission Date": "25/09/2026",
    "Claim filing date": "2026-09-25",
    "Expected Joining Date": "01/11/2026",
    "Nationality": "Indian",
    "Preferred Work Location": "Delhi NCR"
  },
  {
    "Full legal name": "Ananya Iyer",
    "Candidate Name": "Ananya Iyer",
    "Applicant full legal name": "Ananya Iyer",
    "Email address": "ananya.iyer@example.com",
    "Email Address": "ananya.iyer@example.com",
    "Mobile number": "+91 97654 32109",
    "Date of birth": "05/05/1999",
    "Date of Birth": "05/05/1999",
    "Student Enrollment / Reg No.": "KRP-2026-1004",
    "Social Category": "EWS",
    "Aadhaar Number (12 digits)": "456789012345",
    "National ID / Aadhaar number": "456789012345",
    "Bank Account Number": "654321012345",
    "Bank IFSC Code": "AXIS0005432",
    "Scholarship Scheme": "Higher Education Incentive",
    "Claim Submission Date": "28/09/2026",
    "Claim filing date": "2026-09-28",
    "Expected Joining Date": "15/11/2026",
    "Nationality": "Indian",
    "Preferred Work Location": "Remote"
  },
  {
    "Full legal name": "Vikram Singh",
    "Candidate Name": "Vikram Singh",
    "Applicant full legal name": "Vikram Singh",
    "Email address": "vikram.singh@example.com",
    "Email Address": "vikram.singh@example.com",
    "Mobile number": "+91 96543 21098",
    "Date of birth": "18/11/1996",
    "Date of Birth": "18/11/1996",
    "Student Enrollment / Reg No.": "KRP-2026-1005",
    "Social Category": "ST",
    "Aadhaar Number (12 digits)": "567890123456",
    "National ID / Aadhaar number": "567890123456",
    "Bank Account Number": "543210123456",
    "Bank IFSC Code": "PNBB0008765",
    "Scholarship Scheme": "Post-Matric Scholarship",
    "Claim Submission Date": "30/09/2026",
    "Claim filing date": "2026-09-30",
    "Expected Joining Date": "01/12/2026",
    "Nationality": "Indian",
    "Preferred Work Location": "Hyderabad"
  }
];

const krpDataOnly = combinedData.map(row => ({
  "Full legal name": row["Full legal name"],
  "Email address": row["Email address"],
  "Mobile number": row["Mobile number"],
  "Date of birth": row["Date of birth"],
  "Student Enrollment / Reg No.": row["Student Enrollment / Reg No."],
  "Social Category": row["Social Category"],
  "Aadhaar Number (12 digits)": row["Aadhaar Number (12 digits)"],
  "Bank Account Number": row["Bank Account Number"],
  "Bank IFSC Code": row["Bank IFSC Code"],
  "Scholarship Scheme": row["Scholarship Scheme"],
  "Claim Submission Date": row["Claim Submission Date"]
}));

const jobDataOnly = combinedData.map(row => ({
  "Candidate Name": row["Candidate Name"],
  "Email Address": row["Email Address"],
  "Date of Birth": row["Date of Birth"],
  "Expected Joining Date": row["Expected Joining Date"],
  "Nationality": row["Nationality"],
  "Preferred Work Location": row["Preferred Work Location"]
}));

const wb = XLSX.utils.book_new();

const wsCombined = XLSX.utils.json_to_sheet(combinedData);
XLSX.utils.book_append_sheet(wb, wsCombined, "Tourcher Combined Data");

const wsKrp = XLSX.utils.json_to_sheet(krpDataOnly);
XLSX.utils.book_append_sheet(wb, wsKrp, "KRP Claim Data");

const wsJob = XLSX.utils.json_to_sheet(jobDataOnly);
XLSX.utils.book_append_sheet(wb, wsJob, "Job Application Data");

const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
const outputPath = path.join(__dirname, 'tourcher_krp_job_sample_data.xlsx');
fs.writeFileSync(outputPath, buffer);

console.log(`Successfully generated exact match Excel file at:\n  ${outputPath}`);
