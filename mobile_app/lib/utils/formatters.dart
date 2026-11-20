/// "Asha Rao" -> "AR", "naveen" -> "N", "" -> "?"
String initialsOf(String name) {
  final parts =
      name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
  if (parts.isEmpty) return '?';
  if (parts.length == 1) return parts.first[0].toUpperCase();
  return (parts.first[0] + parts.last[0]).toUpperCase();
}

/// "student" -> "Student"
String capitalize(String value) =>
    value.isEmpty ? value : value[0].toUpperCase() + value.substring(1);

String greetingFor(DateTime time) {
  if (time.hour < 12) return 'Good morning';
  if (time.hour < 17) return 'Good afternoon';
  return 'Good evening';
}

final RegExp _emailPattern = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');

String? validateEmail(String? value) {
  final email = value?.trim() ?? '';
  if (email.isEmpty) return 'Please enter your email';
  if (!_emailPattern.hasMatch(email)) return 'Please enter a valid email';
  return null;
}
