/// A student record from GET /students.
///
/// The backend stores students as free-form documents, so every field is
/// read leniently and missing values become empty strings.
class Student {
  const Student({
    required this.studentId,
    required this.name,
    required this.email,
    required this.department,
    required this.semester,
    required this.registrationNumber,
    required this.course,
    required this.section,
    required this.academicYear,
  });

  final String studentId;
  final String name;
  final String email;
  final String department;
  final String semester;
  final String registrationNumber;
  final String course;
  final String section;
  final String academicYear;

  factory Student.fromJson(Map<String, dynamic> json) {
    String read(String key) => (json[key] ?? '').toString().trim();

    return Student(
      studentId: read('student_id'),
      name: read('name'),
      email: read('email'),
      department: read('department'),
      semester: read('semester'),
      registrationNumber: read('registration_number'),
      course: read('course'),
      section: read('section'),
      academicYear: read('academic_year'),
    );
  }

  bool matches(String query) {
    final q = query.trim().toLowerCase();
    if (q.isEmpty) return true;
    return [
      studentId,
      registrationNumber,
      name,
      email,
      department,
      course,
      section,
      academicYear,
    ]
        .any((field) => field.toLowerCase().contains(q));
  }
}
