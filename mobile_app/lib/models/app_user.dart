/// The signed-in user, as returned by GET /me.
class AppUser {
  const AppUser({
    required this.name,
    required this.email,
    required this.role,
    this.studentId,
    this.assignedSubjectCodes = const [],
  });

  final String name;
  final String email;
  final String role;
  final String? studentId;
  final List<String> assignedSubjectCodes;

  bool get isAdmin => role == 'admin';
  bool get isFaculty => role == 'faculty';
  bool get isStudent => role == 'student';

  factory AppUser.fromJson(Map<String, dynamic> json) {
    return AppUser(
      name: (json['name'] ?? '').toString(),
      email: (json['email'] ?? '').toString(),
      role: (json['role'] ?? 'student').toString(),
      studentId: json['student_id']?.toString(),
      assignedSubjectCodes: (json['assigned_subject_codes'] as List?)
              ?.map((e) => e.toString())
              .toList() ??
          const [],
    );
  }
}
