/// The student a response belongs to (from the attendance/timetable APIs).
class StudentSummary {
  const StudentSummary({
    required this.studentId,
    required this.name,
    required this.department,
    required this.semester,
  });

  final String studentId;
  final String name;
  final String department;
  final String semester;

  static StudentSummary? fromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    String read(String key) => (json[key] ?? '').toString();
    return StudentSummary(
      studentId: read('student_id'),
      name: read('name'),
      department: read('department'),
      semester: read('semester'),
    );
  }
}

int readInt(Object? value) => value is num ? value.toInt() : 0;

double readDouble(Object? value) => value is num ? value.toDouble() : 0;
