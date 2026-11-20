class LibraryBook {
  const LibraryBook({
    required this.id,
    required this.title,
    required this.author,
    required this.isbn,
    required this.category,
    required this.totalCopies,
    required this.availableCopies,
  });

  final String id;
  final String title;
  final String author;
  final String isbn;
  final String category;
  final int totalCopies;
  final int availableCopies;

  factory LibraryBook.fromJson(Map<String, dynamic> json) => LibraryBook(
    id: (json['id'] ?? '').toString(),
    title: (json['title'] ?? '').toString(),
    author: (json['author'] ?? '').toString(),
    isbn: (json['isbn'] ?? '').toString(),
    category: (json['category'] ?? '').toString(),
    totalCopies: (json['total_copies'] as num?)?.toInt() ?? 0,
    availableCopies: (json['available_copies'] as num?)?.toInt() ?? 0,
  );
}

class BookLoan {
  const BookLoan({
    required this.id,
    required this.bookId,
    required this.bookTitle,
    required this.bookIsbn,
    required this.status,
    required this.borrowedAt,
    required this.dueAt,
    this.returnedAt,
  });

  final String id;
  final String bookId;
  final String bookTitle;
  final String bookIsbn;
  final String status;
  final DateTime borrowedAt;
  final DateTime dueAt;
  final DateTime? returnedAt;

  bool get isActive => status == 'borrowed';

  factory BookLoan.fromJson(Map<String, dynamic> json) => BookLoan(
    id: (json['id'] ?? '').toString(),
    bookId: (json['book_id'] ?? '').toString(),
    bookTitle: (json['book_title'] ?? '').toString(),
    bookIsbn: (json['book_isbn'] ?? '').toString(),
    status: (json['status'] ?? '').toString(),
    borrowedAt: DateTime.parse(json['borrowed_at'].toString()),
    dueAt: DateTime.parse(json['due_at'].toString()),
    returnedAt: json['returned_at'] == null
        ? null
        : DateTime.parse(json['returned_at'].toString()),
  );
}
